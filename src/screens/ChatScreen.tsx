import React, {useState, useEffect, useRef, useCallback} from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  SafeAreaView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Image,
  ScrollView,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';
import {Socket} from 'socket.io-client';
import io from 'socket.io-client';
import Icon from 'react-native-vector-icons/Ionicons';
import MaterialIcon from 'react-native-vector-icons/MaterialIcons';
import FeatherIcon from 'react-native-vector-icons/Feather';

interface Message {
  id: string;
  text: string;
  userId: string;
  username: string;
  timestamp: number;
  type: 'text' | 'system' | 'emoji';
  chatId?: string; // For direct or group chat
  platform?: string; // Track which platform sent the message
}

interface User {
  id: string;
  username: string;
  isOnline?: boolean;
}

interface ChatScreenProps {
  navigation: any;
  route: {
    params: {
      socket?: Socket;
      userId: string;
      username: string;
      // Direct chat params
      targetUserId?: string;
      targetUsername?: string;
      isDirectChat?: boolean;
      // Group chat params
      isGroupChat?: boolean;
      groupName?: string;
      groupMembers?: User[];
      chatId?: string; // Optional chatId for existing groups
    }
  }
}

// Demo server endpoint - replace with your actual server
const SERVER_URL = Platform.OS === 'ios' ? 'http://localhost:3001' : 'http://10.0.2.2:3001';

const ChatScreen: React.FC<ChatScreenProps> = ({navigation, route}) => {
  const {
    socket: routeSocket, 
    userId, 
    username,
    targetUserId,
    targetUsername,
    isDirectChat,
    isGroupChat,
    groupName,
    groupMembers,
    chatId: existingChatId
  } = route.params;
  
  // Debug logging for cross-platform group chat issue
  console.log(`[${Platform.OS}] ChatScreen initialized with params:`, {
    isDirectChat,
    isGroupChat,
    groupName,
    groupMembers: groupMembers?.map(m => m.username),
    existingChatId,
    Platform: Platform.OS
  });
  
  // More robust group chat detection
  const isActuallyGroupChat = isGroupChat || 
    (groupName && groupName.trim() !== '') || 
    (groupMembers && groupMembers.length > 0) ||
    (existingChatId && existingChatId.startsWith('group-'));
  
  console.log(`[${Platform.OS}] Group chat detection:`, {
    isGroupChat,
    isActuallyGroupChat,
    hasGroupName: !!(groupName && groupName.trim() !== ''),
    hasGroupMembers: !!(groupMembers && groupMembers.length > 0),
    hasGroupChatId: !!(existingChatId && existingChatId.startsWith('group-'))
  });
  
  // Generate a unique chat ID for this conversation
  const chatId = useRef<string>(
    existingChatId ? existingChatId : // Use existing chatId if provided
    isDirectChat && targetUserId
      ? [userId, targetUserId].sort().join('-') // Sort to ensure same ID regardless of who initiates
      : isActuallyGroupChat
        ? `group-${groupName?.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // Unique ID for the group
        : 'global' // Default global chat
  ).current;
  
  console.log(`[${Platform.OS}] ChatScreen initialized with chatId:`, chatId, {
    isDirectChat,
    targetUserId,
    isGroupChat,
    groupName,
    existingChatId
  });

  const [socket, setSocket] = useState<Socket | null>(routeSocket || null);
  const [connected, setConnected] = useState(socket?.connected || false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [onlineUsers, setOnlineUsers] = useState<User[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [showEmojis, setShowEmojis] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [groupInfo, setGroupInfo] = useState<{name: string, members: User[], createdBy?: string}>({
    name: groupName || '',
    members: groupMembers || [],
    createdBy: undefined
  });
  
  const flatListRef = useRef<FlatList>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const deletionAlertShownRef = useRef<boolean>(false);

  useEffect(() => {
    loadMessages();
    
    // If socket wasn't passed or is not connected, create a new connection
    if (!socket || !socket.connected) {
      connectToServer();
    } else {
      // Ensure we join the chat room even if socket is already connected
      if (isDirectChat || isActuallyGroupChat) {
        // Ensure we have valid userId and username before joining
        if (!userId || !username) {
          console.error(`[${Platform.OS}] Missing userId or username when joining chat:`, {
            userId,
            username,
            chatId
          });
          
          // Try to load from AsyncStorage as fallback
          AsyncStorage.getItem('userId').then(storedUserId => {
            AsyncStorage.getItem('username').then(storedUsername => {
              if (storedUserId && storedUsername) {
                console.log(`[${Platform.OS}] Retrieved userId and username from AsyncStorage:`, {
                  userId: storedUserId,
                  username: storedUsername
                });
                
                socket.emit('joinChat', {
                  chatId,
                  userId: storedUserId,
                  username: storedUsername,
                  isGroup: isActuallyGroupChat,
                  groupName: isActuallyGroupChat ? groupName : undefined,
                  members: isActuallyGroupChat ? groupMembers : undefined
                });
                
                // For existing groups, request group info
                if (isActuallyGroupChat && existingChatId) {
                  socket.emit('getGroupInfo', { chatId });
                }
              } else {
                Alert.alert('Error', 'Could not retrieve user information. Please go back and try again.');
              }
            });
          });
        } else {
          socket.emit('joinChat', {
            chatId,
            userId,
            username,
            isGroup: isActuallyGroupChat,
            groupName: isActuallyGroupChat ? groupName : undefined,
            members: isActuallyGroupChat ? groupMembers : undefined
          });
          
          // For existing groups, request group info
          if (isActuallyGroupChat && existingChatId) {
            socket.emit('getGroupInfo', { chatId });
          }
        }
      }
      setupSocketListeners();
    }
    
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      // Reset deletion alert ref when component unmounts
      deletionAlertShownRef.current = false;
    };
  }, []);

  const connectToServer = () => {
    try {
      console.log(`[${Platform.OS}] Connecting to server from ChatScreen:`, SERVER_URL);
      const newSocket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      newSocket.on('connect', () => {
        console.log(`[${Platform.OS}] Connected to server from ChatScreen`);
        setSocket(newSocket);
        setConnected(true);
        
        // Ensure we have valid userId and username before joining
        if (!userId || !username) {
          console.error(`[${Platform.OS}] Missing userId or username when connecting:`, {
            userId,
            username
          });
          
          // Try to load from AsyncStorage as fallback
          AsyncStorage.getItem('userId').then(storedUserId => {
            AsyncStorage.getItem('username').then(storedUsername => {
              if (storedUserId && storedUsername) {
                console.log(`[${Platform.OS}] Retrieved userId and username from AsyncStorage:`, {
                  userId: storedUserId,
                  username: storedUsername
                });
                
                // Join with user info
                newSocket.emit('join', {
                  userId: storedUserId,
                  username: storedUsername,
                });
                
                // Join specific chat room if direct or group chat
                if (isDirectChat || isActuallyGroupChat) {
                  newSocket.emit('joinChat', {
                    chatId,
                    userId: storedUserId,
                    username: storedUsername,
                    isGroup: isActuallyGroupChat,
                    groupName: isActuallyGroupChat ? groupName : undefined,
                    members: isActuallyGroupChat ? groupMembers : undefined
                  });
                  
                  // For existing groups, request group info
                  if (isActuallyGroupChat && existingChatId) {
                    newSocket.emit('getGroupInfo', { chatId });
                  }
                }
                
                addSystemMessage(`Connected as ${storedUsername}`);
              } else {
                Alert.alert('Error', 'Could not retrieve user information. Please go back and try again.');
              }
            });
          });
        } else {
          // Join with user info
          newSocket.emit('join', {
            userId,
            username,
          });
          
          // Join specific chat room if direct or group chat
          if (isDirectChat || isActuallyGroupChat) {
            newSocket.emit('joinChat', {
              chatId,
              userId,
              username,
              isGroup: isActuallyGroupChat,
              groupName: isActuallyGroupChat ? groupName : undefined,
              members: isActuallyGroupChat ? groupMembers : undefined
            });
            
            // For existing groups, request group info
            if (isActuallyGroupChat && existingChatId) {
              newSocket.emit('getGroupInfo', { chatId });
            }
          }
          
          addSystemMessage(`Connected as ${username}`);
        }
        
        setupSocketListeners(newSocket);
      });

      newSocket.on('connect_error', (error) => {
        console.error(`[${Platform.OS}] Connection error from ChatScreen:`, error);
        Alert.alert(
          'Connection Error', 
          'Failed to connect to chat server. Messages will be stored locally.',
          [{ text: 'OK', style: 'default' }]
        );
      });

    } catch (error) {
      console.error(`[${Platform.OS}] Error creating socket connection:`, error);
    }
  };

  const setupSocketListeners = (socketToSetup = socket) => {
    if (!socketToSetup) return;

    socketToSetup.on('disconnect', (reason) => {
      console.log(`[${Platform.OS}] Disconnected from server:`, reason);
      setConnected(false);
      setOnlineUsers([]);
      setTypingUsers([]);
      addSystemMessage('Disconnected from server');
    });

    socketToSetup.on('message', (message: Message) => {
      // Enhanced logging for cross-platform message debugging
      console.log(`[${Platform.OS}] Received message:`, message, 'Current chatId:', chatId);
      
      // Fix for Android/iOS group chat issue - always accept messages for the correct chatId
      if (message.chatId === chatId) {
        console.log(`[${Platform.OS}] Adding message to chat - direct match on chatId`);
        addMessage(message);
      } else if (isDirectChat && message.chatId && message.chatId === [userId, targetUserId].sort().join('-')) {
        console.log(`[${Platform.OS}] Adding message to direct chat - matched sorted IDs`);
        addMessage(message);
      } else if (isActuallyGroupChat && message.chatId && message.chatId.startsWith('group-')) {
        // Double check for group messages - sometimes chatId might be formatted differently
        console.log(`[${Platform.OS}] Group message received with different chatId format. Expected: ${chatId}, Received: ${message.chatId}`);
        
        // If this is a group message and we're in a group chat, check if it's for this group
        if (chatId.includes(message.chatId) || message.chatId.includes(chatId)) {
          console.log(`[${Platform.OS}] Adding message to group chat - partial match on chatId`);
          // Update the message chatId to match our expected format
          message.chatId = chatId;
          addMessage(message);
        } else {
          console.log(`[${Platform.OS}] Ignoring group message - not for this group`);
        }
      } else {
        console.log(`[${Platform.OS}] Ignoring message - chatId mismatch`);
      }
    });

    socketToSetup.on('userJoined', (data: {username: string, chatId?: string}) => {
      // Only show join messages for this chat
      if (!data.chatId || data.chatId === chatId) {
        addSystemMessage(`${data.username} joined the chat`);
      }
    });

    socketToSetup.on('userLeft', (data: {username: string}) => {
      addSystemMessage(`${data.username} left the chat`);
    });

    socketToSetup.on('onlineUsers', (users: User[]) => {
      console.log(`[${Platform.OS}] Received online users in chat:`, users);
      setOnlineUsers(users);
    });

    socketToSetup.on('userTyping', (data: {username: string, isTyping: boolean, chatId: string}) => {
      // Only show typing indicators for this chat
      if (data.chatId === chatId) {
        setTypingUsers(prev => {
          if (data.isTyping) {
            return prev.includes(data.username) ? prev : [...prev, data.username];
          } else {
            return prev.filter(user => user !== data.username);
          }
        });
      }
    });

    socketToSetup.on('groupChatCreated', (data) => {
      console.log(`[${Platform.OS}] Group chat created/updated:`, data);
      if (data.chatId === chatId) {
        setGroupInfo({
          name: data.groupName,
          members: data.members
        });
        addSystemMessage(`Group "${data.groupName}" created by ${data.createdBy}`);
      }
    });

    socketToSetup.on('newGroupChat', (data) => {
      console.log(`[${Platform.OS}] Added to new group chat:`, data);
      // This event is handled in UsersScreen, but we can also handle it here
      // if the user is currently in a chat screen
      if (isActuallyGroupChat && data.chatId === chatId) {
        setGroupInfo({
          name: data.name,
          members: data.members
        });
        addSystemMessage(`You were added to group "${data.name}" by ${data.createdBy}`);
      }
    });

    socketToSetup.on('groupInfo', (data) => {
      console.log(`[${Platform.OS}] Received group info:`, data);
      if (data.chatId === chatId && isActuallyGroupChat) {
        setGroupInfo({
          name: data.name,
          members: data.members,
          createdBy: data.createdBy
        });
      }
    });

    // Add listener for group deletion
    socketToSetup.on('groupDeleted', (data) => {
      console.log(`[${Platform.OS}] Group deleted notification received:`, data);
      if (data.chatId === chatId && !deletionAlertShownRef.current) {
        deletionAlertShownRef.current = true;
        
        // Navigate immediately without waiting for alert confirmation
        navigation.navigate('Users');
        
        // Show alert after navigation with no callbacks
        setTimeout(() => {
          Alert.alert(
            'Group Deleted',
            `The group "${data.groupName}" has been deleted by ${data.deletedBy}.`
          );
        }, 100);
      }
    });

    socketToSetup.on('groupDeleteSuccess', (data) => {
      console.log(`[${Platform.OS}] Group delete success:`, data);
      // No need to show an alert for the person who deleted the group
      // They already confirmed deletion in the confirmation dialog
      // Just ensure we're on the Users screen
      if (data.chatId === chatId) {
        navigation.navigate('Users');
      }
    });
  };

  const loadMessages = async () => {
    try {
      // Load messages for this specific chat
      const storageKey = `chatMessages-${chatId}`;
      const storedMessages = await AsyncStorage.getItem(storageKey);
      if (storedMessages) {
        setMessages(JSON.parse(storedMessages));
      } else if (isDirectChat) {
        // Add initial message for direct chat
        addSystemMessage(`Started chat with ${targetUsername}`);
      } else if (isActuallyGroupChat) {
        // Add initial message for group chat
        addSystemMessage(`Started group chat: ${groupName}`);
        if (groupMembers && groupMembers.length > 0) {
          addSystemMessage(`Members: ${groupMembers.map(m => m.username).join(', ')}`);
        }
      }
    } catch (error) {
      console.error(`[${Platform.OS}] Error loading messages:`, error);
    }
  };

  const saveMessages = async (msgs: Message[]) => {
    try {
      // Save messages for this specific chat
      const storageKey = `chatMessages-${chatId}`;
      await AsyncStorage.setItem(storageKey, JSON.stringify(msgs));
    } catch (error) {
      console.error(`[${Platform.OS}] Error saving messages:`, error);
    }
  };

  const addMessage = useCallback((message: Message) => {
    console.log(`[${Platform.OS}] Adding message to state:`, message);
    setMessages(prev => {
      const newMessages = [...prev, message];
      saveMessages(newMessages);
      return newMessages;
    });
  }, []);

  const addSystemMessage = (text: string) => {
    const systemMessage: Message = {
      id: uuid.v4() as string,
      text,
      userId: 'system',
      username: 'System',
      timestamp: Date.now(),
      type: 'system',
      chatId,
    };
    addMessage(systemMessage);
  };

  const sendMessage = () => {
    if (!inputMessage.trim()) return;

    const message: Message = {
      id: uuid.v4() as string,
      text: inputMessage.trim(),
      userId,
      username,
      timestamp: Date.now(),
      type: 'text',
      chatId,
      platform: Platform.OS, // Add platform info to help with debugging
    };

    // Add message locally first for immediate feedback
    addMessage(message);
    
    console.log(`[${Platform.OS}] Sending message to chatId: ${chatId}`, message);

    // Send to server if connected
    if (socket && connected) {
      socket.emit('message', message);
    }

    setInputMessage('');
    stopTyping();
    
    // Scroll to bottom
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({animated: true});
    }, 100);
  };

  const sendEmoji = (emoji: string) => {
    const message: Message = {
      id: uuid.v4() as string,
      text: emoji,
      userId,
      username,
      timestamp: Date.now(),
      type: 'emoji',
      chatId,
      platform: Platform.OS, // Add platform info to help with debugging
    };

    addMessage(message);

    if (socket && connected) {
      socket.emit('message', message);
    }

    setShowEmojis(false);

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({animated: true});
    }, 100);
  };

  const handleTyping = (text: string) => {
    setInputMessage(text);
    
    if (socket && connected && !isTyping) {
      setIsTyping(true);
      
      // Ensure we have a valid username before sending typing indicator
      if (!username || username.trim() === '') {
        // Try to get username from AsyncStorage
        AsyncStorage.getItem('username').then(storedUsername => {
          if (storedUsername) {
            console.log(`[${Platform.OS}] Retrieved username from AsyncStorage for typing:`, storedUsername);
            
            socket.emit('typing', {
              username: storedUsername,
              isTyping: true, 
              chatId,
              platform: Platform.OS
            });
          } else {
            console.error(`[${Platform.OS}] Could not retrieve username from AsyncStorage for typing`);
            
            // Use socket ID as last resort
            socket.emit('typing', {
              username: socket.id,
              isTyping: true, 
              chatId,
              platform: Platform.OS
            });
          }
        });
      } else {
        console.log(`[${Platform.OS}] Sending typing indicator:`, {
          username,
          chatId,
          platform: Platform.OS
        });
        
        socket.emit('typing', {
          username,
          isTyping: true, 
          chatId,
          platform: Platform.OS
        });
      }
    }

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop typing
    typingTimeoutRef.current = setTimeout(() => {
      stopTyping();
    }, 1000);
  };

  const stopTyping = () => {
    if (socket && connected && isTyping) {
      setIsTyping(false);
      
      // Ensure we have a valid username before sending typing indicator
      if (!username || username.trim() === '') {
        // Try to get username from AsyncStorage
        AsyncStorage.getItem('username').then(storedUsername => {
          if (storedUsername) {
            socket.emit('typing', {
              username: storedUsername,
              isTyping: false, 
              chatId,
              platform: Platform.OS
            });
          } else {
            // Use socket ID as last resort
            socket.emit('typing', {
              username: socket.id,
              isTyping: false, 
              chatId,
              platform: Platform.OS
            });
          }
        });
      } else {
        socket.emit('typing', {
          username,
          isTyping: false, 
          chatId,
          platform: Platform.OS
        });
      }
    }
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  };

  const clearMessages = () => {
    Alert.alert(
      'Clear Messages',
      'Are you sure you want to clear all messages?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            setMessages([]);
            // Clear messages for this specific chat
            const storageKey = `chatMessages-${chatId}`;
            AsyncStorage.removeItem(storageKey);
          },
        },
      ]
    );
    // Close the menu after showing the alert
    setShowMenu(false);
  };

  const goBack = () => {
    navigation.goBack();
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  };

  const renderMessage = ({item}: {item: Message}) => {
    const isOwnMessage = item.userId === userId;
    const isSystemMessage = item.type === 'system';
    const isEmojiMessage = item.type === 'emoji';

    // Enhanced debug logging for group chat issue
    if (isActuallyGroupChat) {
      console.log(`[${Platform.OS}] Rendering message:`, {
        isGroupChat,
        isActuallyGroupChat,
        isOwnMessage,
        username: item.username,
        userId: item.userId,
        currentUserId: userId,
        messageType: item.type,
        messagePlatform: item.platform || 'unknown',
        currentPlatform: Platform.OS,
        chatId: item.chatId,
        currentChatId: chatId
      });
    }

    if (isSystemMessage) {
      return (
        <View style={styles.systemMessageContainer}>
          <Text style={styles.systemMessageText}>{item.text}</Text>
        </View>
      );
    }

    if (isEmojiMessage) {
      return (
        <View style={[
          styles.messageContainer,
          isOwnMessage ? styles.ownMessage : styles.otherMessage
        ]}>
          <View style={[
            styles.emojiBubble,
            isOwnMessage ? styles.ownEmojiBubble : styles.otherEmojiBubble
          ]}>
            <Text style={styles.emojiText}>{item.text}</Text>
            <Text style={[
              styles.messageTime,
              isOwnMessage ? styles.ownMessageTime : styles.otherMessageTime
            ]}>
              {formatTime(item.timestamp)}
            </Text>
          </View>
        </View>
      );
    }

    // Get display username with fallback
    const displayUsername = item.username || 'Unknown User';
    const avatarLetter = displayUsername.charAt(0).toUpperCase() || 'U';

    return (
      <View style={[
        styles.messageContainer,
        isOwnMessage ? styles.ownMessage : styles.otherMessage
      ]}>
        {!isOwnMessage && isActuallyGroupChat && (
          <View style={styles.avatarContainer}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {avatarLetter}
              </Text>
            </View>
          </View>
        )}
        <View style={[
          styles.messageBubble,
          isOwnMessage ? styles.ownMessageBubble : styles.otherMessageBubble
        ]}>
          {!isOwnMessage && isActuallyGroupChat && (
            <Text style={styles.usernameText}>{displayUsername}</Text>
          )}
          <Text style={[
            styles.messageText,
            isOwnMessage ? styles.ownMessageText : styles.otherMessageText
          ]}>
            {item.text}
          </Text>
          <Text style={[
            styles.messageTime,
            isOwnMessage ? styles.ownMessageTime : styles.otherMessageTime
          ]}>
            {formatTime(item.timestamp)}
            {item.platform ? ` · ${item.platform}` : ''}
          </Text>
        </View>
        {isOwnMessage && (
          <View style={styles.messageTail}></View>
        )}
      </View>
    );
  };

  const emojis = ['😀', '😂', '❤️', '👍', '👎', '🔥', '😎', '🎉', '😊', '🙏', '👋', '🤔', '😍', '🤣', '😢', '😡'];

  // Determine the chat title
  const chatTitle = isDirectChat 
    ? targetUsername 
    : isActuallyGroupChat 
      ? groupInfo.name || groupName 
      : 'Socket Chat';

  const toggleMenu = () => {
    setShowMenu(!showMenu);
  };

  const showGroupInfo = () => {
    if (isActuallyGroupChat) {
      Alert.alert(
        `Group: ${groupInfo.name || groupName}`,
        `Members: ${(groupInfo.members || groupMembers || [])
          .map(member => member.username)
          .join(', ')}`,
        [{ text: 'OK' }]
      );
    }
    setShowMenu(false);
  };

  // Add delete group function
  const deleteGroup = () => {
    if (isActuallyGroupChat) {
      // Debug the group deletion issue
      console.log(`[${Platform.OS}] Attempting to delete group:`, {
        chatId,
        userId,
        username,
        groupInfo,
        isCreator: groupInfo.createdBy === userId
      });
      
      // Check if user is the creator of the group
      const isCreator = groupInfo.createdBy === userId;
      
      if (!isCreator) {
        Alert.alert(
          'Cannot Delete Group',
          'Only the group creator can delete this group.',
          [{ text: 'OK' }]
        );
        setShowMenu(false);
        return;
      }
      
      Alert.alert(
        'Delete Group',
        `Are you sure you want to delete the group "${groupInfo.name || groupName}"? This action cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { 
            text: 'Delete', 
            style: 'destructive',
            onPress: () => {
              if (socket && connected) {
                // Set the flag to prevent duplicate alerts
                deletionAlertShownRef.current = true;
                
                console.log(`[${Platform.OS}] Sending deleteGroup event:`, {
                  chatId,
                  userId,
                  username
                });
                
                // Emit the delete event first
                socket.emit('deleteGroup', {
                  chatId,
                  userId,
                  username
                });
                
                // Navigate after a short delay to ensure the event is sent
                setTimeout(() => {
                  navigation.navigate('Users');
                }, 200);
              } else {
                Alert.alert('Error', 'You are not connected to the server.');
              }
            }
          }
        ]
      );
    }
    setShowMenu(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#075E54" translucent={Platform.OS === 'android'} />
      
      {/* Header */}
      <View style={[styles.header, Platform.OS === 'android' && styles.androidHeader]}>
        <TouchableOpacity onPress={goBack} style={styles.backButton}>
          <Icon name="arrow-back" size={24} color="white" />
        </TouchableOpacity>
        
        <View style={styles.headerContent}>
          <View style={styles.avatarContainer}>
            <View style={styles.headerAvatar}>
              {isDirectChat ? (
                <Text style={styles.avatarText}>
                  {targetUsername?.charAt(0).toUpperCase()}
                </Text>
              ) : isActuallyGroupChat ? (
                <Icon name="people" size={20} color="white" />
              ) : (
                <Text style={styles.avatarText}>C</Text>
              )}
            </View>
          </View>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {chatTitle}
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {isDirectChat 
                ? connected ? 'online' : 'offline'
                : isActuallyGroupChat 
                  ? `${(groupInfo.members || groupMembers || []).length} members`
                  : connected ? 'Connected' : 'Disconnected'}
            </Text>
          </View>
        </View>
        
        <TouchableOpacity onPress={toggleMenu} style={styles.menuButton}>
          <MaterialIcon name="more-vert" size={24} color="white" />
        </TouchableOpacity>
        
        {/* Menu Dropdown */}
        {showMenu && (
          <View style={styles.menuDropdown}>
            {isActuallyGroupChat && (
              <TouchableOpacity onPress={showGroupInfo} style={styles.menuItem}>
                <Text style={styles.menuItemText}>Group Info</Text>
              </TouchableOpacity>
            )}
            {isActuallyGroupChat && (
              <TouchableOpacity 
                onPress={deleteGroup} 
                style={[
                  styles.menuItem, 
                  groupInfo.createdBy !== userId && styles.disabledMenuItem
                ]}>
                <Text style={[
                  styles.menuItemText,
                  groupInfo.createdBy !== userId && styles.disabledMenuItemText
                ]}>
                  Delete Group
                  {groupInfo.createdBy !== userId ? ' (Creator Only)' : ''}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={clearMessages} style={styles.menuItem}>
              <Text style={styles.menuItemText}>Clear Messages</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
      
      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messagesList}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({animated: true})}
        onLayout={() => flatListRef.current?.scrollToEnd({animated: true})}
        ListEmptyComponent={
          <View style={styles.emptyMessagesContainer}>
            <Text style={styles.emptyMessagesText}>No messages yet</Text>
            <Text style={styles.emptyMessagesSubtext}>
              {isDirectChat 
                ? `Start chatting with ${targetUsername}`
                : isActuallyGroupChat 
                  ? `Start chatting in ${groupInfo.name || groupName}`
                  : 'Start chatting'}
            </Text>
          </View>
        }
      />
      
      {/* Typing Indicator */}
      {typingUsers.length > 0 && (
        <View style={styles.typingContainer}>
          <Text style={styles.typingText}>
            {typingUsers.length === 1 
              ? `${typingUsers[0]} is typing...` 
              : `${typingUsers.length} people are typing...`}
          </Text>
        </View>
      )}
      
      {/* Emoji Picker */}
      {showEmojis && (
        <View style={styles.emojiContainer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {emojis.map(emoji => (
              <TouchableOpacity 
                key={emoji} 
                style={styles.emojiButton}
                onPress={() => sendEmoji(emoji)}>
                <Text style={styles.emoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
      
      {/* Input Area */}
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}>
        <View style={styles.inputContainer}>
          <TouchableOpacity 
            style={styles.attachButton}
            onPress={() => Alert.alert('Attachment', 'Attachment feature coming soon!')}>
            <Icon name="attach" size={24} color="#666" />
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.emojiToggle}
            onPress={() => setShowEmojis(!showEmojis)}>
            <Icon name="happy-outline" size={24} color="#666" />
          </TouchableOpacity>
          
          <TextInput
            style={styles.input}
            value={inputMessage}
            onChangeText={handleTyping}
            placeholder="Type a message..."
            placeholderTextColor="#999"
            multiline
          />
          
          <TouchableOpacity 
            style={[styles.sendButton, !inputMessage.trim() && styles.disabledSendButton]}
            onPress={sendMessage}
            disabled={!inputMessage.trim()}>
            <Icon name="send" size={20} color="white" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ECE5DD',
  },
  header: {
    backgroundColor: '#075E54',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 15,
  },
  androidHeader: {
    paddingTop: (StatusBar.currentHeight || 0) + 10,
  },
  backButton: {
    marginRight: 10,
    padding: 5,
  },

  headerContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
    ...Platform.select({
      android: {
        includeFontPadding: false, // Remove extra padding on Android
        textAlignVertical: 'center',
        textAlign: 'center',
      },
    }),
  },
  headerInfo: {
    marginLeft: 10,
    flex: 1,
  },
  headerTitle: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerSubtitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
  },
  menuButton: {
    padding: 5,
  },

  menuDropdown: {
    position: 'absolute',
    top: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) + 60 : 60,
    right: 10,
    backgroundColor: 'white',
    borderRadius: 5,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    zIndex: 1000,
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  menuItemText: {
    fontSize: 16,
    color: '#075E54',
  },
  messagesList: {
    padding: 10,
    paddingBottom: 20,
  },
  messageContainer: {
    marginVertical: 5,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  ownMessage: {
    justifyContent: 'flex-end',
  },
  otherMessage: {
    justifyContent: 'flex-start',
  },
  avatarContainer: {
    marginRight: 8,
    minWidth: 30, // Ensure consistent width on Android
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#128C7E',
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      android: {
        elevation: 2, // Add shadow for Android
      },
      ios: {
        shadowColor: '#000',
        shadowOffset: {width: 0, height: 1},
        shadowOpacity: 0.2,
        shadowRadius: 1,
      },
    }),
  },
  messageBubble: {
    maxWidth: '70%',
    padding: 10,
    borderRadius: 15,
    minHeight: 30, // Ensure minimum height on Android
  },
  ownMessageBubble: {
    backgroundColor: '#DCF8C6',
    borderTopRightRadius: 5,
  },
  otherMessageBubble: {
    backgroundColor: 'white',
    borderTopLeftRadius: 5,
  },
  usernameText: {
    color: '#075E54',
    fontWeight: 'bold',
    fontSize: 12,
    marginBottom: 2,
    ...Platform.select({
      android: {
        includeFontPadding: false, // Remove extra padding on Android
        textAlignVertical: 'center',
      },
    }),
  },
  messageText: {
    fontSize: 16,
  },
  ownMessageText: {
    color: '#000',
  },
  otherMessageText: {
    color: '#000',
  },
  messageTime: {
    fontSize: 11,
    marginTop: 2,
    alignSelf: 'flex-end',
  },
  ownMessageTime: {
    color: 'rgba(0,0,0,0.5)',
  },
  otherMessageTime: {
    color: 'rgba(0,0,0,0.5)',
  },
  systemMessageContainer: {
    alignItems: 'center',
    marginVertical: 10,
  },
  systemMessageText: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    color: '#fff',
    fontSize: 12,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  emojiBubble: {
    padding: 5,
    borderRadius: 15,
    alignItems: 'center',
  },
  ownEmojiBubble: {
    backgroundColor: 'transparent',
  },
  otherEmojiBubble: {
    backgroundColor: 'transparent',
  },
  emojiText: {
    fontSize: 30,
  },
  emptyMessagesContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    marginTop: 100,
  },
  emptyMessagesText: {
    fontSize: 18,
    color: 'rgba(0,0,0,0.5)',
    fontWeight: 'bold',
  },
  emptyMessagesSubtext: {
    fontSize: 14,
    color: 'rgba(0,0,0,0.3)',
    marginTop: 5,
    textAlign: 'center',
  },
  typingContainer: {
    padding: 5,
    paddingLeft: 15,
  },
  typingText: {
    color: 'rgba(0,0,0,0.5)',
    fontStyle: 'italic',
    fontSize: 12,
  },
  emojiContainer: {
    backgroundColor: '#fff',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  emojiButton: {
    marginHorizontal: 5,
  },
  emoji: {
    fontSize: 24,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  attachButton: {
    marginRight: 10,
  },
  emojiToggle: {
    marginRight: 10,
  },

  input: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 10,
    maxHeight: 100,
  },
  sendButton: {
    marginLeft: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#128C7E',
    justifyContent: 'center',
    alignItems: 'center',
  },
  disabledSendButton: {
    backgroundColor: '#ccc',
  },

  messageTail: {
    position: 'absolute',
    right: -8,
    bottom: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderLeftColor: 'transparent',
    borderBottomWidth: 10,
    borderBottomColor: '#DCF8C6',
    transform: [{rotate: '45deg'}],
  },

  disabledMenuItem: {
    opacity: 0.5,
  },
  
  disabledMenuItemText: {
    color: '#999',
  },
});

export default ChatScreen; 