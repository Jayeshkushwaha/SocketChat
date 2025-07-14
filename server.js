const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// Store connected users
const connectedUsers = new Map();

// Store active chat rooms
const chatRooms = new Map();

// Store group information
const groupChats = new Map();

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Socket Chat Server is running!',
    connectedUsers: connectedUsers.size,
    chatRooms: chatRooms.size,
    groupChats: groupChats.size,
    timestamp: new Date().toISOString()
  });
});

// Helper function to ensure all group members are in the room
const ensureGroupMembersInRoom = (chatId) => {
  if (!chatId.startsWith('group-') || !groupChats.has(chatId)) {
    return;
  }
  
  const group = groupChats.get(chatId);
  console.log(`Ensuring all members are in group ${chatId} (${group.name})`);
  
  let joinedMembers = 0;
  
  group.members.forEach(member => {
    let memberSocketId = null;
    
    // Find socket ID for this member
    connectedUsers.forEach((user, socketId) => {
      if (user.id === member.id) {
        memberSocketId = socketId;
      }
    });
    
    if (memberSocketId) {
      const memberSocket = io.sockets.sockets.get(memberSocketId);
      if (memberSocket) {
        memberSocket.join(chatId);
        console.log(`Ensuring member ${member.username} (${member.id}) is in room ${chatId}`);
        joinedMembers++;
      }
    }
  });
  
  // Log room status
  const roomSockets = io.sockets.adapter.rooms.get(chatId);
  console.log(`Room ${chatId} now has ${roomSockets ? roomSockets.size : 0} connected clients (${joinedMembers} members joined)`);
  
  // Double check that all sockets are in the room
  if (roomSockets) {
    roomSockets.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const user = connectedUsers.get(socketId);
        if (user) {
          console.log(`Verified socket ${socketId} (${user.username}) is in room ${chatId}`);
        }
      }
    });
  }
};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle user joining
  socket.on('join', (userData) => {
    const { userId, username } = userData;
    
    // Validate user data
    if (!userId || !username || typeof username !== 'string' || username.trim() === '') {
      console.error('Invalid user data received:', userData);
      socket.emit('error', { message: 'Invalid user data' });
      return;
    }
    
    // Check if user is already connected with another socket
    let existingSocketId = null;
    connectedUsers.forEach((user, socketId) => {
      if (user.id === userId) {
        existingSocketId = socketId;
      }
    });
    
    // If user is already connected, disconnect the old socket
    if (existingSocketId && existingSocketId !== socket.id) {
      console.log(`User ${username.trim()} (${userId}) is already connected. Updating socket ID from ${existingSocketId} to ${socket.id}`);
      
      // Remove the old socket entry
      connectedUsers.delete(existingSocketId);
      
      // Try to disconnect the old socket if it still exists
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        console.log(`Disconnecting old socket: ${existingSocketId}`);
        oldSocket.disconnect(true);
      }
    }
    
    // Store user info
    connectedUsers.set(socket.id, {
      id: userId,
      username: username.trim(),
      socketId: socket.id,
      joinedAt: new Date().toISOString()
    });

    console.log(`User ${username.trim()} (${userId}) joined`);
    
    // Broadcast to all clients that user joined
    socket.broadcast.emit('userJoined', { username: username.trim() });
    
    // Send updated online users list to all clients (filter out invalid users)
    const onlineUsers = Array.from(connectedUsers.values())
      .filter(user => user.username && user.username.trim() !== '')
      .map(user => ({
        id: user.id,
        username: user.username.trim(),
        isOnline: true
      }));
    
    io.emit('onlineUsers', onlineUsers);
    
    // Send available group chats to the newly connected user
    const userGroups = [];
    groupChats.forEach((group, groupId) => {
      if (group.members.some(member => member.id === userId)) {
        userGroups.push({
          chatId: groupId,
          name: group.name,
          members: group.members.filter(member => member.username && member.username.trim() !== ''),
          createdBy: group.createdBy
        });
      }
    });
    
    if (userGroups.length > 0) {
      socket.emit('availableGroups', userGroups);
      
      // Ensure user is joined to all their group rooms
      userGroups.forEach(group => {
        socket.join(group.chatId);
        console.log(`Joining user ${username.trim()} to their group: ${group.name} (${group.chatId})`);
      });
    }
  });

  // Handle joining specific chat rooms (direct or group)
  socket.on('joinChat', (chatData) => {
    const { chatId, userId, username, isGroup, groupName, members } = chatData;
    
    // Join the socket to the chat room
    socket.join(chatId);
    
    console.log(`User ${username} joined chat room: ${chatId}`);
    console.log(`Chat room details: isGroup=${isGroup}, name=${isGroup ? groupName : 'Direct Chat'}`);
    
    // Store chat room info if it's a new room
    if (!chatRooms.has(chatId)) {
      chatRooms.set(chatId, {
        id: chatId,
        isGroup,
        name: isGroup ? groupName : 'Direct Chat',
        createdAt: new Date().toISOString(),
        members: isGroup ? members : []
      });
    }
    
    // For group chats, store additional information and notify all members
    if (isGroup && members && members.length > 0) {
      // Validate group data
      if (!groupName || typeof groupName !== 'string' || groupName.trim() === '') {
        console.error('Invalid group name:', groupName);
        socket.emit('error', { message: 'Invalid group name' });
        return;
      }
      
      // Filter out members with invalid usernames
      const validMembers = members.filter(member => 
        member && member.username && typeof member.username === 'string' && member.username.trim() !== ''
      );
      
      if (validMembers.length === 0) {
        console.error('No valid members for group:', groupName);
        socket.emit('error', { message: 'No valid members for group' });
        return;
      }
      
      // Check if this is a new group or existing group
      const isNewGroup = !groupChats.has(chatId);
      
      // Store group chat info
      groupChats.set(chatId, {
        id: chatId,
        name: groupName.trim(),
        createdBy: userId,
        createdAt: new Date().toISOString(),
        members: validMembers.map(member => ({
          id: member.id,
          username: member.username.trim()
        }))
      });
      
      console.log(`Group chat ${isNewGroup ? 'created' : 'updated'}: ${groupName.trim()} with ${validMembers.length} members`);
      
      // Find all members' socket IDs and make them join the room
      const notifiedMembers = [];
      validMembers.forEach(member => {
        let memberSocketId = null;
        
        // Find socket ID for this member
        connectedUsers.forEach((user, socketId) => {
          if (user.id === member.id) {
            memberSocketId = socketId;
          }
        });
        
        if (memberSocketId) {
          const memberSocket = io.sockets.sockets.get(memberSocketId);
          if (memberSocket) {
            memberSocket.join(chatId);
            console.log(`Added member ${member.username.trim()} (${member.id}) to group ${groupName.trim()}`);
            
            // Notify member about the new group (except the creator for new groups)
            if (isNewGroup && member.id !== userId) {
              memberSocket.emit('newGroupChat', {
                chatId,
                name: groupName.trim(),
                createdBy: username,
                members: validMembers.map(m => ({
                  id: m.id,
                  username: m.username.trim()
                }))
              });
              notifiedMembers.push(member.username.trim());
            }
          }
        }
      });
      
      // Double check that all members are in the room
      setTimeout(() => {
        const roomSockets = io.sockets.adapter.rooms.get(chatId);
        console.log(`After setup, room ${chatId} has ${roomSockets ? roomSockets.size : 0} connected clients`);
        
        // If any members are missing, try to add them again
        if (roomSockets && roomSockets.size < validMembers.length) {
          console.log(`Some members may be missing from room ${chatId}, attempting to re-add them`);
          
          validMembers.forEach(member => {
            let memberSocketId = null;
            
            // Find socket ID for this member
            connectedUsers.forEach((user, socketId) => {
              if (user.id === member.id) {
                memberSocketId = socketId;
              }
            });
            
            if (memberSocketId) {
              const memberSocket = io.sockets.sockets.get(memberSocketId);
              if (memberSocket) {
                memberSocket.join(chatId);
                console.log(`Re-added member ${member.username.trim()} (${member.id}) to group ${groupName.trim()}`);
              }
            }
          });
        }
      }, 500); // Small delay to ensure initial join operations complete
      
      // Broadcast group creation/update to all members in the room
      if (isNewGroup) {
        // Don't send to creator, they already have the group
        const groupCreatedData = {
          chatId,
          groupName: groupName.trim(),
          createdBy: username,
          members: validMembers.map(m => ({
            id: m.id,
            username: m.username.trim()
          }))
        };
        
        // Send to all members except the creator
        validMembers.forEach(member => {
          if (member.id !== userId) {
            let memberSocketId = null;
            
            // Find socket ID for this member
            connectedUsers.forEach((user, socketId) => {
              if (user.id === member.id) {
                memberSocketId = socketId;
              }
            });
            
            if (memberSocketId) {
              const memberSocket = io.sockets.sockets.get(memberSocketId);
              if (memberSocket) {
                memberSocket.emit('groupChatCreated', groupCreatedData);
              }
            }
          }
        });
        
        if (notifiedMembers.length > 0) {
          console.log(`Notified members about new group: ${notifiedMembers.join(', ')}`);
        }
      }
    }
    
    // For direct chats, make sure both users are in the room
    if (!isGroup && chatId.includes('-')) {
      const userIds = chatId.split('-');
      console.log(`Direct chat between users: ${userIds.join(' and ')}`);
      
      // Find the socket IDs for both users
      const socketIds = [];
      connectedUsers.forEach((user, socketId) => {
        if (userIds.includes(user.id)) {
          socketIds.push(socketId);
        }
      });
      
      // Make sure all users are in the room
      socketIds.forEach(sid => {
        const socket = io.sockets.sockets.get(sid);
        if (socket) {
          socket.join(chatId);
          console.log(`Ensuring user socket ${sid} is in room ${chatId}`);
        }
      });
    }
    
    // Notify others in the room that user joined
    socket.to(chatId).emit('userJoined', { username, chatId });
  });

  // Handle message sending
  socket.on('message', (messageData) => {
    console.log('Message received:', messageData);
    
    const { chatId, username, userId, platform } = messageData;
    
    // Ensure username is properly set
    if (!username || username.trim() === '') {
      console.error('Message received without valid username:', messageData);
      // Try to get username from connected users
      const user = connectedUsers.get(socket.id);
      if (user && user.username) {
        messageData.username = user.username;
        messageData.userId = user.id;
        console.log('Fixed username and userId from connected users:', {
          username: messageData.username,
          userId: messageData.userId
        });
      } else {
        console.error('Could not determine username for message');
        // Even if we can't determine the username, still try to deliver the message
        // This ensures messages from iOS clients with missing user data still get delivered
        if (chatId) {
          console.log('Attempting to deliver message despite missing user data');
          messageData.username = messageData.username || 'Unknown User';
          messageData.userId = messageData.userId || `unknown-${Date.now()}`;
        } else {
          return;
        }
      }
    }
    
    if (chatId) {
      // Log the message details for debugging
      console.log(`Sending message to chat room: ${chatId}`);
      console.log(`Message from: ${messageData.username} (${messageData.userId})`);
      console.log(`Message type: ${messageData.type}, Platform: ${platform || 'Unknown'}`);
      
      // Enhanced logging for group chats to debug cross-platform issues
      if (chatId.startsWith('group-')) {
        console.log(`GROUP CHAT MESSAGE: ${chatId} from ${platform || 'Unknown platform'}`);
        
        // Log all sockets in this room for debugging
        const roomSockets = io.sockets.adapter.rooms.get(chatId);
        if (roomSockets) {
          console.log(`Room ${chatId} has ${roomSockets.size} connected clients`);
          
          // Ensure all users in the group are properly joined to the room
          ensureGroupMembersInRoom(chatId);
        } else {
          console.log(`Room ${chatId} not found or has no connected clients`);
          // Create the room if it doesn't exist
          if (groupChats.has(chatId)) {
            console.log(`Re-creating room for existing group: ${chatId}`);
            ensureGroupMembersInRoom(chatId);
          }
        }
      }
      
      // For group chats, use a more reliable broadcast method
      if (chatId.startsWith('group-') && groupChats.has(chatId)) {
        const group = groupChats.get(chatId);
        
        // Send message to each member individually to ensure delivery
        group.members.forEach(member => {
          if (member.id !== messageData.userId) { // Don't send to sender
            let memberSocketId = null;
            
            // Find socket ID for this member
            connectedUsers.forEach((user, socketId) => {
              if (user.id === member.id) {
                memberSocketId = socketId;
              }
            });
            
            if (memberSocketId) {
              const memberSocket = io.sockets.sockets.get(memberSocketId);
              if (memberSocket) {
                console.log(`Sending message directly to member ${member.username} (${member.id})`);
                memberSocket.emit('message', messageData);
              } else {
                console.log(`Socket not found for member ${member.username} (${member.id})`);
              }
            } else {
              console.log(`Member ${member.username} (${member.id}) is not currently connected`);
            }
          }
        });
      } else {
        // For direct chats, use room broadcast
        socket.to(chatId).emit('message', messageData);
      }
      
      // Store in chat history (optional, for future persistence)
      if (chatRooms.has(chatId)) {
        const chatRoom = chatRooms.get(chatId);
        if (!chatRoom.messages) {
          chatRoom.messages = [];
        }
        chatRoom.messages.push(messageData);
        chatRooms.set(chatId, chatRoom);
      }
    } else {
      // Broadcast to all (global chat)
      socket.broadcast.emit('message', messageData);
    }
  });

  // Handle typing indicators
  socket.on('typing', (typingData) => {
    const { username, isTyping, chatId, platform } = typingData;
    
    // Fix for empty username in typing indicator
    if (!username || username.trim() === '' || username === 'Unknown User') {
      console.log('Typing indicator received without valid username:', typingData);
      // Try to get username from connected users
      const user = connectedUsers.get(socket.id);
      if (user && user.username) {
        typingData.username = user.username;
        console.log('Fixed username in typing indicator:', typingData.username);
      } else {
        console.error('Could not determine username for typing indicator');
        // Generate a temporary username as fallback
        typingData.username = `User-${socket.id.substring(0, 5)}`;
        console.log('Using fallback username for typing indicator:', typingData.username);
      }
    }
    
    console.log(`${typingData.username} is ${isTyping ? 'typing' : 'stopped typing'} in chat ${chatId}`);
    
    if (chatId) {
      // For group chats, ensure all members are in the room before sending typing indicator
      if (chatId.startsWith('group-') && groupChats.has(chatId)) {
        ensureGroupMembersInRoom(chatId);
      }
      
      // Send to specific chat room
      socket.to(chatId).emit('userTyping', { 
        username: typingData.username, 
        isTyping, 
        chatId,
        platform: platform || 'unknown'
      });
    } else {
      // Broadcast to all (global chat)
      socket.broadcast.emit('userTyping', { 
        username: typingData.username, 
        isTyping, 
        chatId: 'global',
        platform: platform || 'unknown'
      });
    }
  });

  // Handle username changes
  socket.on('usernameChange', (data) => {
    const { oldUsername, newUsername } = data;
    
    // Validate new username
    if (!newUsername || typeof newUsername !== 'string' || newUsername.trim() === '') {
      console.error('Invalid new username:', newUsername);
      socket.emit('error', { message: 'Invalid username' });
      return;
    }
    
    // Update stored user info
    if (connectedUsers.has(socket.id)) {
      const user = connectedUsers.get(socket.id);
      user.username = newUsername.trim();
      connectedUsers.set(socket.id, user);
    }
    
    console.log(`Username changed from ${oldUsername} to ${newUsername.trim()}`);
    
    // Broadcast username change to all clients
    socket.broadcast.emit('message', {
      id: `system-${Date.now()}`,
      text: `${oldUsername} changed their name to ${newUsername.trim()}`,
      userId: 'system',
      username: 'System',
      timestamp: Date.now(),
      type: 'system'
    });
    
    // Send updated online users list (filter out invalid users)
    const onlineUsers = Array.from(connectedUsers.values())
      .filter(user => user.username && user.username.trim() !== '')
      .map(user => ({
        id: user.id,
        username: user.username.trim(),
        isOnline: true
      }));
    
    io.emit('onlineUsers', onlineUsers);
  });

  // Handle getting group info
  socket.on('getGroupInfo', (data) => {
    const { chatId } = data;
    
    if (groupChats.has(chatId)) {
      const group = groupChats.get(chatId);
      socket.emit('groupInfo', {
        chatId,
        name: group.name,
        members: group.members,
        createdBy: group.createdBy,
        createdAt: group.createdAt
      });
      
      // Ensure the user is in the room
      socket.join(chatId);
      console.log(`User requested group info for ${chatId}, ensuring they are in the room`);
    }
  });

  // Handle group deletion
  socket.on('deleteGroup', (data) => {
    const { chatId, userId, username } = data;
    
    console.log(`Request to delete group ${chatId} by user ${username} (${userId})`);
    
    if (groupChats.has(chatId)) {
      const group = groupChats.get(chatId);
      
      // Check if the user is the creator of the group
      if (group.createdBy === userId) {
        // Get all members before deleting
        const members = group.members;
        
        // Delete the group
        groupChats.delete(chatId);
        
        // Remove from chat rooms
        chatRooms.delete(chatId);
        
        console.log(`Group ${group.name} (${chatId}) deleted by ${username}`);
        
        // Notify all members about the deletion
        members.forEach(member => {
          let memberSocketId = null;
          
          // Find socket ID for this member
          connectedUsers.forEach((user, socketId) => {
            if (user.id === member.id) {
              memberSocketId = socketId;
            }
          });
          
          if (memberSocketId) {
            const memberSocket = io.sockets.sockets.get(memberSocketId);
            if (memberSocket) {
              memberSocket.emit('groupDeleted', {
                chatId,
                groupName: group.name,
                deletedBy: username
              });
              console.log(`Notified member ${member.username} about group deletion`);
            }
          }
        });
        
        // Send success response to the requester
        socket.emit('groupDeleteSuccess', {
          chatId,
          groupName: group.name
        });
      } else {
        // User is not authorized to delete the group
        console.log(`Unauthorized deletion attempt by ${username} for group ${group.name}`);
        socket.emit('error', { 
          message: 'You are not authorized to delete this group',
          type: 'unauthorized_delete'
        });
      }
    } else {
      // Group not found
      console.log(`Group not found: ${chatId}`);
      socket.emit('error', { 
        message: 'Group not found',
        type: 'group_not_found'
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const user = connectedUsers.get(socket.id);
    if (user && user.username && user.username.trim() !== '') {
      console.log(`User ${user.username.trim()} left`);
      
      // Broadcast to all clients that user left
      socket.broadcast.emit('userLeft', { username: user.username.trim() });
      
      // Remove user from connected users
      connectedUsers.delete(socket.id);
      
      // Send updated online users list (filter out invalid users)
      const onlineUsers = Array.from(connectedUsers.values())
        .filter(user => user.username && user.username.trim() !== '')
        .map(user => ({
          id: user.id,
          username: user.username.trim(),
          isOnline: true
        }));
      
      io.emit('onlineUsers', onlineUsers);
    } else {
      // Just remove the user without broadcasting if username is invalid
      connectedUsers.delete(socket.id);
    }
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Socket Chat Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🌐 Health check available at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
}); 