import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Animated,
  Image,
  Share,
  Platform
} from 'react-native';
import { Audio } from 'expo-av';
import { uploadAudio } from '../services/api';
import { colors, shadows } from '../styles/theme';
import * as FileSystem from 'expo-file-system';
import * as Network from 'expo-network';
import io from 'socket.io-client/dist/socket.io';
import { API_URL } from '../services/api';

// Animation frames for facial animation (placeholders - you'd replace with actual assets)
const ANIMATION_FRAMES = {
  neutral: require('../assets/face-neutral.png'),
  speaking: [
    require('../assets/face-speak-1.png'),
    require('../assets/face-speak-2.png'),
    require('../assets/face-speak-3.png'),
  ]
};

// Whisper detection configuration
const WHISPER_CONFIG = {
  AMPLITUDE_THRESHOLD: 0.015, // Lower threshold for whispers
  UPPER_THRESHOLD: 0.15,      // Upper threshold (above this is normal speech)
  DETECTION_WINDOW: 2000,     // Time window to determine if whispering (ms)
  MIN_DURATION: 500,          // Minimum duration for a valid whisper (ms)
};

const AudioRecorder = () => {
  // Existing state
  const [recording, setRecording] = useState(null);
  const [sound, setSound] = useState(null);
  const [message, setMessage] = useState("Press button to start recording");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [colabResult, setColabResult] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [ttsAudio, setTtsAudio] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingQueue, setProcessingQueue] = useState([]);
  const [isProcessingEnabled, setIsProcessingEnabled] = useState(true);
  const [currentlyPlaying, setCurrentlyPlaying] = useState(null);
  const [transcriptions, setTranscriptions] = useState([]);
  const [isRecording, setIsRecording] = useState(false);

  // New state for enhanced features
  const [isWhispering, setIsWhispering] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [audioChunks, setAudioChunks] = useState([]);
  const [streamingEnabled, setStreamingEnabled] = useState(true);
  const [prediction, setPrediction] = useState('');
  const [speakingAnimation, setSpeakingAnimation] = useState(false);
  const [faceFrame, setFaceFrame] = useState(0);
  const [listening, setListening] = useState(false);
  const [confidenceLevel, setConfidenceLevel] = useState(0);
  const socketRef = useRef(null);
  const recordingRef = useRef(null);
  const animationRef = useRef(new Animated.Value(0)).current;

  // Connect to WebSocket
  useEffect(() => {
    // Initialize socket connection
    const setupSocket = async () => {
      try {
        const ipAddress = await Network.getIpAddressAsync();
        const socketURL = API_URL; 
        console.log(`Connecting to socket at ${socketURL}`);
        
        const socket = io(socketURL, {
          transports: ['websocket'],
          reconnection: true
        });

        socket.on('connect', () => {
          console.log('Socket connected');
        });

        socket.on('transcription_complete', (data) => {
          console.log('Received transcription:', data);
          if (data.session_id === sessionId) {
            handleTranscriptionResult(data.result);
          }
        });

        socket.on('disconnect', () => {
          console.log('Socket disconnected');
        });

        socket.on('error', (error) => {
          console.error('Socket error:', error);
        });

        socketRef.current = socket;
        return () => socket.disconnect();
      } catch (error) {
        console.error('Socket setup error:', error);
      }
    };

    setupSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Handle facial animation
  useEffect(() => {
    let animationTimer;
    
    if (speakingAnimation) {
      animationTimer = setInterval(() => {
        setFaceFrame((prev) => (prev + 1) % ANIMATION_FRAMES.speaking.length);
      }, 200); // Change frame every 200ms
    }
    
    return () => {
      if (animationTimer) {
        clearInterval(animationTimer);
      }
    };
  }, [speakingAnimation]);

  // Animation for confidence level
  useEffect(() => {
    Animated.timing(animationRef, {
      toValue: confidenceLevel,
      duration: 300,
      useNativeDriver: false
    }).start();
  }, [confidenceLevel]);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (recording) {
        stopRecording().catch(console.error);
      }
      if (sound) {
        sound.unloadAsync().catch(console.error);
      }
    };
  }, []);

  // Process audio in chunks and detect whispers
  const onRecordingStatusUpdate = async (status) => {
    if (!status.isRecording) return;
    
    const { durationMillis, metering } = status;
    
    // Detect whisper based on amplitude
    // metering is in dB, we need to convert to amplitude
    const amplitude = metering ? Math.pow(10, metering / 20) : 0;
    
    // Whisper detection logic
    if (amplitude > WHISPER_CONFIG.AMPLITUDE_THRESHOLD && 
        amplitude < WHISPER_CONFIG.UPPER_THRESHOLD) {
      // Potential whisper detected
      if (!isWhispering) {
        setIsWhispering(true);
        setMessage("Whisper detected - listening...");
      }
    } else if (amplitude > WHISPER_CONFIG.UPPER_THRESHOLD) {
      // Too loud for a whisper
      setIsWhispering(false);
      setMessage("Please whisper more softly");
    } else {
      // Too quiet
      if (isWhispering) {
        // Was whispering but stopped
        setIsWhispering(false);
      }
    }
    
    // Create audio chunks at appropriate intervals for streaming
    if (durationMillis % 1000 < 50 && streamingEnabled && isWhispering) {
      try {
        const uri = await recording.getURI();
        console.log("Getting audio chunk at", durationMillis);
        // In a real implementation, you would extract just this chunk
        streamAudioChunk(uri, durationMillis > 2000);
      } catch (error) {
        console.error("Error getting audio chunk:", error);
      }
    }
  };

  // Stream audio chunk to server for real-time processing
  const streamAudioChunk = async (uri, shouldProcess = false) => {
    try {
      if (!sessionId) {
        // Create a new session if needed
        const newSessionId = Math.random().toString(36).substring(2, 15);
        setSessionId(newSessionId);
      }
      
      // In a production app, you would extract just the new audio chunk
      // Here we're sending the whole file each time as a simplified example
      const chunk = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      
      // Send via websocket for faster processing
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('stream_audio', {
          audio: chunk,
          session_id: sessionId,
          is_final: shouldProcess
        });
      }
      
    } catch (error) {
      console.error("Error streaming audio chunk:", error);
    }
  };

  // Handle transcription results from server
  const handleTranscriptionResult = (result) => {
    if (result.transcription) {
      // Add to transcriptions list
      const newTranscription = {
        id: Date.now(),
        text: result.transcription,
        timestamp: new Date().toLocaleTimeString()
      };
      
      setTranscriptions(prev => [newTranscription, ...prev]);
      
      // Start facial animation
      setSpeakingAnimation(true);
      
      // Play TTS if available
      if (result.tts_audio_url) {
        playTTSAudio(API_URL + result.tts_audio_url);
      }
      
      // Update prediction for next words
      if (result.transcription.split(' ').length > 3) {
        generatePrediction(result.transcription);
      }
    }
  };

  // Generate predictive text using a simple approach
  // In a real app, you might use a more sophisticated algorithm
  const generatePrediction = (text) => {
    const words = text.split(' ');
    if (words.length < 3) return;
    
    const lastThreeWords = words.slice(-3).join(' ');
    
    // Simple prediction - in a real app, you'd use a language model
    const predictions = {
      "I am going": ["to", "home", "out"],
      "going to the": ["store", "mall", "park"],
      "thank you for": ["your help", "listening", "understanding"]
    };
    
    if (predictions[lastThreeWords]) {
      setPrediction(predictions[lastThreeWords][0]);
      setConfidenceLevel(0.8); // Confidence level from 0 to 1
    } else {
      setPrediction('');
      setConfidenceLevel(0);
    }
  };

  // Accept predicted text
  const acceptPrediction = () => {
    if (!prediction) return;
    
    // Append prediction to last transcription
    setTranscriptions(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[0] = {
        ...updated[0],
        text: updated[0].text + ' ' + prediction
      };
      return updated;
    });
    
    // Reset prediction
    setPrediction('');
  };

  // Share transcription to other platforms
  const shareTranscription = async (text) => {
    try {
      const result = await Share.share({
        message: text,
        title: 'AVAASS Transcription'
      });
      
      if (result.action === Share.sharedAction) {
        if (result.activityType) {
          console.log(`Shared via ${result.activityType}`);
        } else {
          console.log('Shared successfully');
        }
      }
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  const startRecording = async () => {
    try {
      // Clean up previous recording if necessary
      if (recording) {
        await recording.stopAndUnloadAsync();
      }
      
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        setMessage('Permission denied');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      // Create a new recording with metering enabled for amplitude detection
      const { recording: newRecording } = await Audio.Recording.createAsync(
        {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
          android: {
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
            extension: '.m4a',
            outputFormat: Audio.AndroidOutputFormat.MPEG_4,
            audioEncoder: Audio.AndroidAudioEncoder.AAC,
          },
          ios: {
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
            extension: '.m4a',
            outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
            audioQuality: Audio.IOSAudioQuality.MAX,
          },
          web: {
            mimeType: 'audio/webm',
            bitsPerSecond: 128000,
          },
          isMeteringEnabled: true, // Important for whisper detection!
        },
        onRecordingStatusUpdate
      );

      // Create a new session ID
      const newSessionId = Math.random().toString(36).substring(2, 15);
      setSessionId(newSessionId);
      
      recordingRef.current = newRecording;
      setRecording(newRecording);
      setIsRecording(true);
      setMessage("Recording started - please whisper");
      setTranscriptions([]);
      setPrediction('');
      setAudioChunks([]);
    } catch (err) {
      console.error('Start recording error:', err);
      setMessage("Failed to start recording");
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    try {
      setListening(false);
      setSpeakingAnimation(false);
      
      if (!recording) return;
      
      // Finalize recording
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      
      // Upload the complete audio for processing
      setIsRecording(false);
      setIsProcessing(true);
      setMessage("Processing your whisper...");
      
      try {
        const response = await uploadAudio(uri);
        handleProcessingComplete(response);
      } catch (error) {
        console.error('Upload error:', error);
        setMessage("Failed to process audio");
      } finally {
        setIsProcessing(false);
      }
      
      // Reset recording state
      recordingRef.current = null;
      setRecording(null);
      setIsWhispering(false);
      
    } catch (err) {
      console.error('Stop recording error:', err);
      setMessage("Failed to stop recording");
      setIsRecording(false);
    }
  };

  const handleProcessingComplete = (result) => {
    setMessage("Ready to record");
    if (result?.colab_response?.transcription) {
      // TTS audio should play automatically
      playTTSAudio(result.colab_response.tts_audio_url);
    }
  };

  const playTTSAudio = async (audioUrl) => {
    try {
      if (sound) {
        await sound.unloadAsync();
      }

      setSpeakingAnimation(true);
      
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: audioUrl },
        { shouldPlay: true }
      );
      
      setSound(newSound);
      
      newSound.setOnPlaybackStatusUpdate(status => {
        if (status.didJustFinish) {
          setSpeakingAnimation(false);
          newSound.unloadAsync();
        }
      });
    } catch (error) {
      console.error('Audio playback error:', error);
      setSpeakingAnimation(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Facial Animation Component */}
      <View style={styles.faceContainer}>
        <Image
          source={speakingAnimation ? ANIMATION_FRAMES.speaking[faceFrame] : ANIMATION_FRAMES.neutral}
          style={styles.faceAnimation}
          resizeMode="contain"
        />
      </View>
      
      {/* Predictive Text Display */}
      {prediction ? (
        <TouchableOpacity 
          style={styles.predictionContainer} 
          onPress={acceptPrediction}
        >
          <Text style={styles.predictionText}>{prediction}</Text>
          <Animated.View 
            style={[
              styles.confidenceBar, 
              {width: animationRef.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%']
              })}
            ]}
          />
        </TouchableOpacity>
      ) : null}
      
      {/* Transcriptions */}
      <View style={styles.transcriptionContainer}>
        <Text style={styles.containerTitle}>Transcriptions</Text>
        <ScrollView style={styles.scrollView}>
          {transcriptions.length === 0 ? (
            <Text style={styles.emptyText}>No transcriptions yet.{'\n'}Start whispering to begin.</Text>
          ) : (
            transcriptions.map(item => (
              <View key={item.id} style={styles.transcriptionItem}>
                <Text style={styles.transcriptionText}>{item.text}</Text>
                <View style={styles.transcriptionActions}>
                  <Text style={styles.timestamp}>{item.timestamp}</Text>
                  <TouchableOpacity 
                    onPress={() => shareTranscription(item.text)}
                    style={styles.shareButton}
                  >
                    <Text style={styles.shareButtonText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </View>

      {/* Recording Controls */}
      <View style={styles.controlsContainer}>
        <Text style={styles.message}>{message}</Text>
        <TouchableOpacity 
          style={[
            styles.recordButton, 
            isRecording && styles.recordingActive,
            isWhispering && styles.whisperingActive
          ]}
          onPress={() => isRecording ? stopRecording() : startRecording()}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <ActivityIndicator color={colors.textLight} size="small" />
          ) : (
            <Text style={styles.buttonText}>
              {isRecording ? 'Stop' : 'Start Whispering'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 20,
  },
  transcriptionContainer: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderRadius: 15,
    padding: 15,
    marginBottom: 20,
    ...shadows.main,
  },
  containerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 15,
    textAlign: 'center',
  },
  scrollView: {
    flex: 1,
  },
  transcriptionItem: {
    backgroundColor: colors.background,
    padding: 15,
    borderRadius: 10,
    marginBottom: 10,
    ...shadows.main,
  },
  transcriptionText: {
    fontSize: 16,
    color: colors.text,
    marginBottom: 5,
  },
  transcriptionActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  timestamp: {
    fontSize: 12,
    color: colors.secondary,
  },
  shareButton: {
    backgroundColor: colors.secondary,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 5,
  },
  shareButtonText: {
    color: colors.textLight,
    fontSize: 12,
  },
  emptyText: {
    textAlign: 'center',
    color: colors.secondary,
    fontStyle: 'italic',
    marginTop: 20,
  },
  controlsContainer: {
    padding: 20,
    backgroundColor: colors.inputBg,
    borderRadius: 15,
    ...shadows.main,
  },
  recordButton: {
    backgroundColor: colors.primary,
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
  },
  recordingActive: {
    backgroundColor: colors.error,
  },
  whisperingActive: {
    backgroundColor: colors.accent,
  },
  buttonText: {
    color: colors.textLight,
    fontSize: 16,
    fontWeight: '600',
  },
  message: {
    color: colors.text,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 10,
  },
  faceContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  faceAnimation: {
    width: 120,
    height: 120,
  },
  predictionContainer: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    padding: 10,
    marginBottom: 15,
    alignItems: 'center',
    ...shadows.main,
  },
  predictionText: {
    color: colors.textLight,
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 5,
  },
  confidenceBar: {
    height: 4,
    backgroundColor: colors.primary,
    borderRadius: 2,
    alignSelf: 'flex-start',
  },
});

export default AudioRecorder;
