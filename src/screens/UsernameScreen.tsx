import React, {useState, useEffect} from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';

interface UsernameScreenProps {
  navigation: any;
}

const UsernameScreen: React.FC<UsernameScreenProps> = ({navigation}) => {
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Check if username already exists but don't navigate automatically
    checkExistingUsername();
  }, []);

  const checkExistingUsername = async () => {
    try {
      const storedUsername = await AsyncStorage.getItem('username');
      
      if (storedUsername) {
        setUsername(storedUsername);
      }
      
      // We're removing the automatic navigation to Users screen
      // This way user can see and change their username before proceeding
    } catch (error) {
      console.error('Error checking existing username:', error);
    }
  };

  const handleContinue = async () => {
    if (!username.trim()) {
      Alert.alert('Username Required', 'Please enter a username to continue');
      return;
    }

    setIsLoading(true);
    
    try {
      // Save username to AsyncStorage
      await AsyncStorage.setItem('username', username.trim());
      
      // Generate and save user ID if not exists
      let userId = await AsyncStorage.getItem('userId');
      if (!userId) {
        userId = uuid.v4() as string;
        await AsyncStorage.setItem('userId', userId);
      }
      
      // Navigate to Users screen
      navigation.replace('Users');
    } catch (error) {
      console.error('Error saving username:', error);
      Alert.alert('Error', 'Failed to save username. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#075E54" translucent={Platform.OS === 'android'} />
      
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoidingView}>
        <View style={[
          styles.content,
          Platform.OS === 'android' && styles.androidContent
        ]}>
          <View style={styles.logoContainer}>
            <View style={styles.logoCircle}>
              <Text style={styles.logoText}>💬</Text>
            </View>
          </View>
          
          <Text style={styles.title}>Welcome to Socket Chat</Text>
          <Text style={styles.subtitle}>Enter your name to get started</Text>
          
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="Your name"
              placeholderTextColor="#999"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
            />
          </View>
          
          <TouchableOpacity
            style={[styles.button, !username.trim() && styles.buttonDisabled]}
            onPress={handleContinue}
            disabled={!username.trim() || isLoading}>
            <Text style={styles.buttonText}>
              {isLoading ? 'Please wait...' : 'CONTINUE'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  keyboardAvoidingView: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  androidContent: {
    paddingTop: StatusBar.currentHeight || 0,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 30,
  },
  logoCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#25D366',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoText: {
    fontSize: 50,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#075E54',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 30,
    textAlign: 'center',
  },
  inputContainer: {
    width: '100%',
    marginBottom: 20,
  },
  input: {
    width: '100%',
    height: 50,
    backgroundColor: '#fff',
    borderBottomWidth: 2,
    borderBottomColor: '#075E54',
    paddingHorizontal: 15,
    fontSize: 16,
  },
  button: {
    width: '100%',
    height: 50,
    backgroundColor: '#128C7E',
    borderRadius: 5,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  buttonDisabled: {
    backgroundColor: '#CCCCCC',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  privacyText: {
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});

export default UsernameScreen; 