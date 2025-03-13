import React, { useState, useEffect } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Image } from 'react-native';
import { Audio } from 'expo-av';
import AudioRecorder from './components/AudioRecorder';
import Login from './components/Login';
import { auth } from './firebase/config';
import { onAuthStateChanged } from 'firebase/auth';
import { colors } from './styles/theme';
import { checkServerHealth } from './services/api';

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState(null);
  const [serverStatus, setServerStatus] = useState('checking');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsLoggedIn(!!user);
    });

    async function prepare() {
      try {
        // Request audio permissions
        await Audio.requestPermissionsAsync();
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
        
        // Check server health
        const status = await checkServerHealth();
        console.log('Server status:', status);
        
        // Check if ML models are loaded
        const modelsLoaded = status.models &&
          status.models.asr_model === 'loaded' &&
          status.models.tts_model === 'loaded' &&
          status.models.noise_reduction === 'loaded';
          
        if (modelsLoaded) {
          setServerStatus('ready');
        } else {
          setServerStatus('loading');
          // Poll server until models are loaded
          const interval = setInterval(async () => {
            try {
              const updatedStatus = await checkServerHealth();
              const allLoaded = updatedStatus.models &&
                updatedStatus.models.asr_model === 'loaded' &&
                updatedStatus.models.tts_model === 'loaded' &&
                updatedStatus.models.noise_reduction === 'loaded';
                
              if (allLoaded) {
                setServerStatus('ready');
                clearInterval(interval);
              }
            } catch (err) {
              console.error('Error checking server status:', err);
            }
          }, 5000); // Check every 5 seconds
          
          // Clean up interval
          return () => clearInterval(interval);
        }
      } catch (error) {
        console.error('Error during initialization:', error);
        setServerStatus('error');
      } finally {
        setIsLoading(false);
      }
    }
    
    prepare();

    return () => unsubscribe();
  }, []);

  // Render loading screen
  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Image 
          source={require('./assets/icon.png')}
          style={styles.loadingLogo}
          resizeMode="contain"
        />
        <Text style={styles.loadingText}>AVAASS</Text>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Render server status screen
  if (serverStatus === 'loading') {
    return (
      <View style={[styles.container, styles.centered]}>
        <Image 
          source={require('./assets/icon.png')}
          style={styles.loadingLogo}
          resizeMode="contain"
        />
        <Text style={styles.loadingText}>AVAASS</Text>
        <Text style={styles.statusText}>
          Loading ML models...{'\n'}This might take a few minutes
        </Text>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Render error screen
  if (serverStatus === 'error') {
    return (
      <View style={[styles.container, styles.centered]}>
        <Image 
          source={require('./assets/icon.png')}
          style={styles.loadingLogo}
          resizeMode="contain"
        />
        <Text style={styles.loadingText}>AVAASS</Text>
        <Text style={styles.errorText}>
          Could not connect to the server.{'\n'}
          Please check your connection and restart the app.
        </Text>
      </View>
    );
  }

  // Render main app
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.appTitle}>AVAASS</Text>
        <Text style={styles.appSubtitle}>Audio-Visual Assistive Speech System</Text>
      </View>
      
      {isLoggedIn ? (
        <AudioRecorder />
      ) : (
        <Login onLogin={() => setIsLoggedIn(true)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 40,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  header: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  appTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: colors.primary,
    marginBottom: 4,
  },
  appSubtitle: {
    fontSize: 14,
    color: colors.secondary,
    marginBottom: 10,
  },
  loadingLogo: {
    width: 120,
    height: 120,
    marginBottom: 20,
  },
  loadingText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: colors.primary,
    marginBottom: 20,
  },
  statusText: {
    fontSize: 16,
    color: colors.secondary,
    textAlign: 'center',
    marginBottom: 20,
  },
  errorText: {
    fontSize: 16,
    color: colors.error,
    textAlign: 'center',
    marginBottom: 20,
  }
});
