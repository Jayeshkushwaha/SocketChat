/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {StatusBar, SafeAreaView, Platform} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

// Import screens
import UsernameScreen from './src/screens/UsernameScreen';
import UsersScreen from './src/screens/UsersScreen';
import ChatScreen from './src/screens/ChatScreen';

// Define user interface
interface User {
  id: string;
  username: string;
  isOnline?: boolean;
}

// Define the stack navigator types
type RootStackParamList = {
  Username: undefined;
  Users: undefined;
  Chat: {
    socket: any;
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
  };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const App = () => {
  return (
    <NavigationContainer>
      <StatusBar 
        barStyle="light-content" 
        backgroundColor="#075E54"
        translucent={Platform.OS === 'android'} 
      />
      <Stack.Navigator 
        initialRouteName="Username"
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="Username" component={UsernameScreen} />
        <Stack.Screen name="Users" component={UsersScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

export default App;
