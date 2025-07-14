import React, {useState, useEffect, useCallback, useMemo} from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  SafeAreaView,
  StatusBar,
  Alert,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  ScrollView,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import io, {Socket} from 'socket.io-client';
import Icon from 'react-native-vector-icons/Ionicons';
import MaterialIcon from 'react-native-vector-icons/MaterialIcons';

interface User {
  id: string;
  username: string;
  isOnline: boolean;
  lastSeen?: number;
}

interface GroupChat {
  chatId: string;
  name: string;
  members: User[];
  createdBy?: string;
}

interface GroupChatCreatedEvent {
  chatId: string;
  groupName: string;
  members: User[];
  createdBy?: string;
}

interface UsersScreenProps {
  navigation: any;
}

// Demo server endpoint - replace with your actual server
const SERVER_URL = Platform.OS === 'ios' ? 'http://localhost:3001' : 'http://10.0.2.2:3001';

const UsersScreen: React.FC<UsersScreenProps> = ({navigation}) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  
  // Group chat state
  const [isGroupModalVisible, setIsGroupModalVisible] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [availableGroups, setAvailableGroups] = useState<GroupChat[]>([]);
  const [showGroups, setShowGroups] = useState(false);

  useEffect(() => {
    // Load user info
    loadUserInfo();

    // Clean up on unmount
    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, []);

  const loadUserInfo = async () => {
    try {
      const storedUserId = await AsyncStorage.getItem('userId');
      const storedUsername = await AsyncStorage.getItem('username');
      
      if (!storedUserId || !storedUsername) {
        // If no user info, go back to username screen
        navigation.replace('Username');
        return;
      }
      
      setUserId(storedUserId);
      setUsername(storedUsername);
      
      // Connect to server
      connectToServer(storedUserId, storedUsername);
    } catch (error) {
      console.error('Error loading user info:', error);
      Alert.alert('Error', 'Failed to load user information.');
      navigation.replace('Username');
    }
  };

  const connectToServer = (userId: string, username: string) => {
    setIsLoading(true);
    setConnectionError(null);
    
    try {
      console.log('Connecting to server:', SERVER_URL);
      const newSocket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      newSocket.on('connect', () => {
        console.log('Connected to server');
        setConnected(true);
        setSocket(newSocket);
        setConnectionError(null);
        
        // Join with user info
        newSocket.emit('join', {
          userId,
          username,
        });
      });

      newSocket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        setConnected(false);
        setOnlineUsers([]);
      });

      newSocket.on('onlineUsers', (users: User[]) => {
        console.log('Received online users:', users);
        
        // Filter out duplicate users by ID
        const uniqueUsers = users.reduce((acc: User[], current) => {
          // Check if we already have this user ID in our accumulator
          const userExists = acc.find(user => user.id === current.id);
          if (!userExists) {
            // Only add the user if they don't already exist
            acc.push(current);
          }
          return acc;
        }, []);
        
        console.log(`Filtered ${users.length} users to ${uniqueUsers.length} unique users`);
        setOnlineUsers(uniqueUsers);
        setIsLoading(false);
        setIsRefreshing(false);
      });

      newSocket.on('availableGroups', (groups: GroupChat[]) => {
        console.log('Received available groups:', groups);
        setAvailableGroups(groups);
      });

      newSocket.on('newGroupChat', (groupData: GroupChat) => {
        console.log(`[${Platform.OS}] Added to new group:`, groupData);
        
        // Use functional update to avoid race conditions
        setAvailableGroups(prev => {
          const existingGroup = prev.find(g => g.chatId === groupData.chatId);
          if (existingGroup) {
            console.log('Group already exists, skipping duplicate:', groupData.chatId);
            return prev;
          }
          
          console.log('Adding new group to list:', groupData.name);
          const updatedGroups = [...prev, groupData];
          
          // Force re-render by updating state
          setTimeout(() => {
            setAvailableGroups(current => [...current]);
          }, 100);
          
          return updatedGroups;
        });
        
        // Show notification
        Alert.alert(
          'New Group Chat',
          `You've been added to "${groupData.name}" by ${groupData.createdBy}`,
          [
            { 
              text: 'View', 
              onPress: () => {
                setShowGroups(true); // Switch to groups tab
                setTimeout(() => {
                  // Ensure we have valid user data before navigating
                  if (!userId || !username) {
                    console.error(`[${Platform.OS}] Missing userId or username when viewing new group:`, {
                      userId,
                      username,
                      groupId: groupData.chatId
                    });
                    Alert.alert('Error', 'Could not retrieve user information. Please restart the app and try again.');
                    return;
                  }
                  
                  console.log(`[${Platform.OS}] Navigating to new group chat:`, {
                    groupId: groupData.chatId,
                    userId,
                    username
                  });
                  
                  navigateToGroupChat(groupData);
                }, 100);
              }
            },
            { 
              text: 'Later', 
              style: 'cancel' 
            }
          ]
        );
      });

      newSocket.on('groupChatCreated', (groupData: GroupChatCreatedEvent) => {
        console.log('Group chat created event received:', groupData);
        
        // Only add if this user is NOT the creator (creator gets it via navigation)
        // and if the group doesn't already exist
        setAvailableGroups(prev => {
          const existingGroup = prev.find(g => g.chatId === groupData.chatId);
          if (existingGroup) {
            console.log('Group already exists, skipping duplicate from groupChatCreated:', groupData.chatId);
            return prev;
          }
          
          // Check if current user is in the group members
          const isUserInGroup = groupData.members && groupData.members.some(member => member.id === userId);
          
          if (isUserInGroup) {
            console.log('Adding group from groupChatCreated event:', groupData.groupName);
            return [...prev, {
              chatId: groupData.chatId,
              name: groupData.groupName,
              members: groupData.members,
              createdBy: groupData.createdBy
            }];
          }
          
          return prev;
        });
      });

      // Handle group deletion
      newSocket.on('groupDeleted', (data) => {
        console.log('Group deleted notification received in UsersScreen:', data);
        
        // Remove the deleted group from the list immediately
        setAvailableGroups(prev => {
          console.log('Filtering out deleted group:', data.chatId);
          return prev.filter(group => group.chatId !== data.chatId);
        });
        
        // Force a re-render of the groups list
        setTimeout(() => {
          setShowGroups(true);
        }, 50);
        
        // Check if the user is currently viewing this group
        const currentRoute = navigation.getCurrentRoute?.();
        const isInChatScreen = currentRoute?.name === 'Chat';
        const isViewingDeletedGroup = isInChatScreen && 
          currentRoute?.params?.chatId === data.chatId;
        
        // Only show notification if not currently in the chat screen for this group
        // The ChatScreen will handle its own navigation and alert
        if (!isViewingDeletedGroup) {
          setTimeout(() => {
            Alert.alert(
              'Group Deleted',
              `The group "${data.groupName}" has been deleted by ${data.deletedBy}.`
            );
          }, 100);
        }
      });

      newSocket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        setConnected(false);
        setConnectionError(`Connection failed: ${error.message}`);
        setIsLoading(false);
        setIsRefreshing(false);
        
        Alert.alert(
          'Connection Error', 
          'Failed to connect to chat server. Please try again later.',
          [{ text: 'OK', style: 'default' }]
        );
      });

      setSocket(newSocket);
    } catch (error) {
      console.error('Error connecting to server:', error);
      setConnectionError(`Connection error: ${error}`);
      setIsLoading(false);
      setIsRefreshing(false);
      Alert.alert('Connection Error', 'Failed to connect to chat server.');
    }
  };

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    if (socket && socket.connected) {
      // Request updated user list
      socket.emit('join', { userId, username });
    } else {
      // Try to reconnect
      connectToServer(userId, username);
    }
  }, [socket, userId, username]);

  const handleStartChat = (targetUser: User) => {
    // Generate the chatId the same way as in ChatScreen
    const directChatId = [userId, targetUser.id].sort().join('-');
    console.log(`Starting direct chat with ${targetUser.username}, chatId: ${directChatId}`);
    
    // Navigate to chat screen with the selected user
    navigation.navigate('Chat', { 
      socket, 
      userId, 
      username,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username,
      isDirectChat: true
    });
  };

  const navigateToGroupChat = (group: GroupChat) => {
    console.log(`[${Platform.OS}] Navigating to group chat:`, {
      groupId: group.chatId,
      userId,
      username
    });
    
    navigation.navigate('Chat', {
      socket,
      userId,
      username,
      isGroupChat: true,
      groupName: group.name,
      chatId: group.chatId,
      groupMembers: group.members
    });
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers(prev => {
      if (prev.includes(userId)) {
        return prev.filter(id => id !== userId);
      } else {
        return [...prev, userId];
      }
    });
  };

  const handleCreateGroup = () => {
    if (!groupName.trim()) {
      Alert.alert('Error', 'Please enter a group name');
      return;
    }

    if (selectedUsers.length === 0) {
      Alert.alert('Error', 'Please select at least one user');
      return;
    }

    // Check if group name is too long
    if (groupName.trim().length > 50) {
      Alert.alert('Error', 'Group name is too long. Maximum 50 characters allowed.');
      return;
    }

    // Add current user to the group
    const groupMembers = [...selectedUsers];
    if (!groupMembers.includes(userId)) {
      groupMembers.push(userId);
    }

    // Create a unique chat ID for the group using timestamp and random component
    const chatId = `group-${groupName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create group members object array
    const members = groupMembers.map(id => {
      const user = onlineUsers.find(user => user.id === id);
      return {
        id,
        username: user ? user.username : id === userId ? username : 'Unknown',
        isOnline: user ? user.isOnline : id === userId ? true : false
      };
    });

    console.log('Creating group:', {
      chatId,
      groupName,
      members: members.map(m => m.username)
    });

    // Immediately add the group to the list for instant visibility
    const newGroup: GroupChat = {
      chatId,
      name: groupName.trim(),
      members,
      createdBy: username
    };

    setAvailableGroups(prev => [...prev, newGroup]);

    // Force switch to groups tab for immediate visibility
    setShowGroups(true);

    // Show success message
    Alert.alert(
      'Group Created',
      `Group "${groupName}" has been created with ${members.length} members.`,
      [
        {
          text: 'OK',
          onPress: () => {
            // Navigate to chat screen with group info
            navigation.navigate('Chat', {
              socket,
              userId,
              username,
              isGroupChat: true,
              chatId,
              groupName,
              groupMembers: members
            });
          }
        }
      ]
    );

    // Reset group state
    setIsGroupModalVisible(false);
    setGroupName('');
    setSelectedUsers([]);
  };

  const renderUserItem = ({item}: {item: User}) => {
    const isCurrentUser = item.id === userId;
    const lastSeen = item.lastSeen ? new Date(item.lastSeen).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
    
    // Don't render if username is missing or invalid
    if (!item.username || item.username.trim() === '' || item.username === 'Unknown') {
      return null;
    }
    
    return (
      <TouchableOpacity 
        onPress={() => !isCurrentUser && handleStartChat(item)}
        disabled={isCurrentUser}
        style={styles.userItem}
        activeOpacity={0.7}>
        <View style={styles.avatarContainer}>
          <View style={[styles.avatar, {backgroundColor: isCurrentUser ? '#075E54' : '#128C7E'}]}>
            <Text style={styles.avatarText}>{item.username.charAt(0).toUpperCase()}</Text>
          </View>
          {item.isOnline && !isCurrentUser && <View style={styles.onlineDot} />}
        </View>
        <View style={styles.userInfo}>
          <Text style={styles.username} numberOfLines={1}>
            {item.username} {isCurrentUser && '(You)'}
          </Text>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.isOnline ? 'online' : lastSeen ? `Last seen: ${lastSeen}` : 'offline'}
          </Text>
        </View>
        {!isCurrentUser && (
          <View style={styles.messageTime}>
            <Text style={styles.timeText}>
              {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderGroupUserItem = ({item}: {item: User}) => {
    const isCurrentUser = item.id === userId;
    const isSelected = selectedUsers.includes(item.id);
    
    // Don't render if username is missing or invalid
    if (!item.username || item.username.trim() === '' || item.username === 'Unknown') {
      return null;
    }
    
    return (
      <TouchableOpacity 
        onPress={() => !isCurrentUser && toggleUserSelection(item.id)}
        disabled={isCurrentUser}
        style={styles.groupUserItem}
        activeOpacity={0.7}>
        <View style={styles.groupUserAvatarContainer}>
          <View style={[styles.groupUserAvatar, isSelected && styles.selectedUserAvatar]}>
            <Text style={styles.avatarText}>{item.username.charAt(0).toUpperCase()}</Text>
            {isSelected && (
              <View style={styles.checkmark}>
                <Icon name="checkmark" size={14} color="#25D366" />
              </View>
            )}
          </View>
        </View>
        <Text style={styles.groupUsername} numberOfLines={1}>
          {item.username} {isCurrentUser && '(You)'}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderGroupItem = ({item}: {item: GroupChat}) => {
    // Don't render if group name is missing
    if (!item.name || item.name.trim() === '') {
      return null;
    }
    
    return (
      <TouchableOpacity 
        onPress={() => navigateToGroupChat(item)}
        style={styles.userItem}
        activeOpacity={0.7}>
                 <View style={styles.avatarContainer}>
           <View style={[styles.avatar, {backgroundColor: '#075E54'}]}>
             <Icon name="people" size={24} color="white" />
           </View>
         </View>
        <View style={styles.userInfo}>
          <Text style={styles.username} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.members.length} member{item.members.length !== 1 ? 's' : ''}
          </Text>
        </View>
        <View style={styles.messageTime}>
          <Text style={styles.timeText}>
            {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // Filter out users without valid usernames and current user
  // Also ensure we don't have duplicate users
  const displayUsers = useMemo(() => {
    // First filter out the current user and invalid usernames
    const filtered = onlineUsers.filter(user => 
      user.id !== userId && 
      user.username && 
      user.username.trim() !== '' && 
      user.username !== 'Unknown'
    );
    
    // Then remove any duplicates by ID
    const uniqueUsers = filtered.reduce((acc: User[], current) => {
      const userExists = acc.find(user => user.id === current.id);
      if (!userExists) {
        acc.push(current);
      }
      return acc;
    }, []);
    
    return uniqueUsers;
  }, [onlineUsers, userId]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#075E54" translucent={Platform.OS === 'android'} />
      
      {/* Header */}
      <View style={[styles.header, Platform.OS === 'android' && styles.androidHeader]}>
        <Text style={styles.headerTitle}>Chats</Text>
        <TouchableOpacity 
          style={styles.searchButton}
          onPress={() => Alert.alert('Search', 'Search feature coming soon!')}>
          <Icon name="search" size={24} color="white" />
        </TouchableOpacity>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity 
          style={[styles.tab, !showGroups && styles.activeTab]} 
          onPress={() => setShowGroups(false)}>
          <Text style={[styles.tabText, !showGroups && styles.activeTabText]}>Chats</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.tab, showGroups && styles.activeTab]} 
          onPress={() => {
            console.log(`${Platform.OS}: Switching to groups tab, available groups:`, availableGroups.length);
            setShowGroups(true);
          }}>
          <Text style={[styles.tabText, showGroups && styles.activeTabText]}>Groups</Text>
          {availableGroups.length > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{availableGroups.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* User List or Group List */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#128C7E" />
          <Text style={styles.loadingText}>Connecting to server...</Text>
        </View>
      ) : connectionError ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Failed to connect to server</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => connectToServer(userId, username)}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : showGroups ? (
        <FlatList
          data={availableGroups}
          keyExtractor={item => item.chatId}
          renderItem={renderGroupItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              colors={['#128C7E']}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No groups available</Text>
              <Text style={styles.emptySubText}>Create a new group to get started</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={displayUsers}
          keyExtractor={item => item.id}
          renderItem={renderUserItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              colors={['#128C7E']}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No users available</Text>
              <Text style={styles.emptySubText}>Pull down to refresh</Text>
            </View>
          }
        />
      )}

      {/* Group Creation Modal */}
      <Modal
        visible={isGroupModalVisible}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setIsGroupModalVisible(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={[styles.modalHeader, Platform.OS === 'android' && styles.androidModalHeader]}>
            <TouchableOpacity 
              onPress={() => {
                setIsGroupModalVisible(false);
                setGroupName('');
                setSelectedUsers([]);
              }}
              style={styles.modalBackButton}>
              <Icon name="arrow-back" size={24} color="white" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>New Group</Text>
            <TouchableOpacity
              style={[
                styles.modalCreateButton,
                (!groupName.trim() || selectedUsers.length === 0) && styles.disabledButton
              ]}
              onPress={handleCreateGroup}
              disabled={!groupName.trim() || selectedUsers.length === 0}>
              <Text style={styles.modalCreateButtonText}>Create</Text>
            </TouchableOpacity>
          </View>
          
          <View style={styles.groupNameContainer}>
            <View style={styles.groupIconContainer}>
              <Text style={styles.groupIcon}>👥</Text>
            </View>
            <TextInput
              style={styles.groupNameInput}
              value={groupName}
              onChangeText={setGroupName}
              placeholder="Group name"
              placeholderTextColor="#999"
              maxLength={50}
            />
          </View>
          
          {groupName.trim().length > 0 && (
            <Text style={styles.characterCount}>
              {groupName.trim().length}/50 characters
            </Text>
          )}
          
          <Text style={styles.selectUsersTitle}>
            Add participants ({selectedUsers.length} selected)
          </Text>
          
          {selectedUsers.length > 0 && (
            <View style={styles.selectedUsersContainer}>
              <Text style={styles.selectedUsersTitle}>Selected:</Text>
              <Text style={styles.selectedUsersText}>
                {selectedUsers.map(id => {
                  const user = onlineUsers.find(u => u.id === id);
                  return user ? user.username : 'Unknown';
                }).join(', ')}
              </Text>
            </View>
          )}
          
          <FlatList
            data={onlineUsers}
            keyExtractor={item => item.id}
            renderItem={renderGroupUserItem}
            numColumns={4}
            contentContainerStyle={styles.groupUsersList}
          />
        </SafeAreaView>
      </Modal>
      
      {/* Floating Action Button */}
      <TouchableOpacity
        style={[styles.fab, Platform.OS === 'android' ? styles.fabAndroid : null]}
        onPress={() => setIsGroupModalVisible(true)}>
        <Icon name="add" size={28} color="white" />
      </TouchableOpacity>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    backgroundColor: '#075E54',
    paddingHorizontal: 20,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  androidHeader: {
    paddingTop: (StatusBar.currentHeight || 0) + 16,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  searchButton: {
    padding: 8,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#075E54',
    paddingBottom: 12,
    paddingHorizontal: 20,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    borderRadius: 8,
    marginHorizontal: 4,
  },
  tabText: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '600',
    fontSize: 16,
    letterSpacing: 0.3,
  },
  activeTab: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  activeTabText: {
    color: '#ffffff',
  },
  badge: {
    backgroundColor: '#25D366',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    paddingHorizontal: 6,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  listContent: {
    flexGrow: 1,
  },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
    backgroundColor: '#FFFFFF',
  },
  avatarContainer: {
    marginRight: 16,
    position: 'relative',
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#128C7E',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  avatarText: {
    color: 'white',
    fontSize: 20,
    fontWeight: '600',
  },
  userInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  username: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000',
    marginBottom: 4,
    letterSpacing: 0.2,
  },
  lastMessage: {
    fontSize: 15,
    color: '#8696A0',
    letterSpacing: 0.1,
  },
  onlineDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#25D366',
    position: 'absolute',
    bottom: 2,
    right: 2,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F7F8FA',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#128C7E',
    fontWeight: '500',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#F7F8FA',
  },
  errorText: {
    fontSize: 16,
    color: '#FF3B30',
    marginBottom: 20,
    textAlign: 'center',
    fontWeight: '500',
  },
  retryButton: {
    backgroundColor: '#128C7E',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 25,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    marginTop: 60,
  },
  emptyText: {
    fontSize: 18,
    color: '#128C7E',
    marginBottom: 12,
    fontWeight: '600',
  },
  emptySubText: {
    fontSize: 15,
    color: '#8696A0',
    textAlign: 'center',
    lineHeight: 22,
  },
  fab: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#25D366',
    justifyContent: 'center',
    alignItems: 'center',
    bottom: 20,
    right: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    zIndex: 999,
  },
  
  fabAndroid: {
    bottom: 40, // Increased bottom margin for Android to avoid overlapping with navigation
    right: 20,
  },

  modalContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  modalHeader: {
    backgroundColor: '#075E54',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  androidModalHeader: {
    paddingTop: (StatusBar.currentHeight || 0) + 16,
  },
  modalBackButton: {
    padding: 8,
  },
  modalBackButtonText: {
    color: 'white',
    fontSize: 24,
    fontWeight: '400',
  },
  modalTitle: {
    color: 'white',
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  modalCreateButton: {
    backgroundColor: '#25D366',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  disabledButton: {
    opacity: 0.5,
  },
  modalCreateButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  groupNameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
  },
  groupIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#F0F2F5',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  groupIcon: {
    fontSize: 28,
  },
  groupNameInput: {
    flex: 1,
    fontSize: 18,
    color: '#000',
    fontWeight: '400',
  },
  characterCount: {
    fontSize: 13,
    color: '#8696A0',
    marginLeft: 20,
    marginBottom: 16,
  },
  selectUsersTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#075E54',
    margin: 20,
    marginBottom: 16,
  },
  selectedUsersContainer: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
    backgroundColor: '#F0F2F5',
    marginHorizontal: 20,
    marginBottom: 16,
    borderRadius: 8,
  },
  selectedUsersTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#075E54',
    marginBottom: 8,
    marginTop: 12,
  },
  selectedUsersText: {
    fontSize: 14,
    color: '#54656F',
    lineHeight: 20,
  },
  groupUsersList: {
    padding: 16,
  },
  groupUserItem: {
    width: '25%',
    alignItems: 'center',
    marginBottom: 24,
    paddingHorizontal: 4,
  },
  groupUserAvatarContainer: {
    marginBottom: 8,
    position: 'relative',
  },
  groupUserAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#128C7E',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  selectedUserAvatar: {
    backgroundColor: '#25D366',
    borderWidth: 3,
    borderColor: '#25D366',
  },
  checkmark: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'white',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#25D366',
  },

  groupUsername: {
    fontSize: 13,
    color: '#000',
    textAlign: 'center',
    fontWeight: '500',
    lineHeight: 18,
  },
  messageTime: {
    marginLeft: 10,
    alignItems: 'flex-end',
  },
  timeText: {
    fontSize: 13,
    color: '#8696A0',
    fontWeight: '400',
  },
});

export default UsersScreen; 