import { useState, useRef, useEffect, useCallback } from 'react';
import '../components/ChatInterface.css';

// Extend Window interface to include webkitSpeechRecognition
declare global {
  interface Window {
    webkitSpeechRecognition: typeof SpeechRecognition;
  }
}

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

const ChatInterface = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isAutoChat, setIsAutoChat] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthesisRef = useRef<SpeechSynthesisUtterance | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const speak = useCallback((text: string) => {
    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();
      
      return new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        synthesisRef.current = utterance;
        
        // Configure voice settings
        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(voice => 
          voice.name.includes('Google') && voice.lang.includes('en')
        );
        
        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
        
        utterance.onend = () => {
          resolve();
        };
        
        window.speechSynthesis.speak(utterance);
      });
    }
    return Promise.resolve();
  }, []);

  const processAIResponse = useCallback(async (text: string) => {
    if (!text.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: text,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('https://n8n.srv650558.hstgr.cloud/webhook/rag-model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ text: text }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const contentType = response.headers.get('content-type');
      let aiText = '';
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        aiText = data.response || data.output || 'I received your message but got no response.';
      } else {
        aiText = await response.text();
      }

      const aiMessage: Message = {
        id: Date.now().toString(),
        text: aiText,
        sender: 'ai',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, aiMessage]);
      await speak(aiText);
      
      // Restart listening after speech is done
      if (isAutoChat) {
        startListening();
      }
    } catch (error) {
      console.error('Error:', error);
      const errorMessage: Message = {
        id: Date.now().toString(),
        text: 'Sorry, there was an error processing your request. Please try again.',
        sender: 'ai',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const startListening = useCallback((): void => {
    if (!isAutoChat) return; // Don't start if auto-chat is off
    
    // Clean up any existing recognition first
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        console.log('Error stopping previous recognition:', e);
      }
      recognitionRef.current = null;
    }
    
    console.log('Starting speech recognition...');

    // Check for speech recognition support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Your browser does not support speech recognition. Please use Chrome, Edge, or Safari.');
      return;
    }
    
    setIsListening(true);
    
    // Create a new recognition instance
    const recognition = new SpeechRecognition();
    recognition.continuous = false; // We'll handle continuous mode manually
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;

    let finalTranscript = '';
    let isProcessing = false;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Clear any existing timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }

      // Process the results
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript = transcript; // Only keep the latest final transcript
        } else {
          interimTranscript = transcript;
        }
      }

      setInput(finalTranscript || interimTranscript);

      // Set a timer to process the final transcript when the user stops speaking
      if (finalTranscript.trim()) {
        silenceTimerRef.current = setTimeout(async () => {
          if (finalTranscript.trim() && !isProcessing) {
            isProcessing = true;
            await processAIResponse(finalTranscript);
            isProcessing = false;
            
            // In auto-chat mode, ensure we keep listening
            // The recognition.onend handler will handle restarting
          }
        }, 1000); // Shorter delay for better responsiveness
      }
    };

    recognition.onend = () => {
      if (!isAutoChat) {
        setIsListening(false);
        return;
      }
      
      // Always try to restart in auto-chat mode
      if (isAutoChat) {
        // Small delay before restarting to prevent rapid reconnection
        const restartDelay = isLoading ? 1000 : 300; // Longer delay if still processing
        
        const restartTimer = setTimeout(() => {
          if (isAutoChat) { // Double check we're still in auto-chat mode
            if (recognitionRef.current) {
              try {
                recognitionRef.current.stop();
              } catch (e) {
                console.log('Error stopping recognition in onend:', e);
              }
            }
            console.log('Restarting speech recognition...');
            startListening();
          }
        }, restartDelay);
        
        // Clean up the timer if component unmounts
        return () => clearTimeout(restartTimer);
      }
      
      setIsListening(false);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      
      // Only restart on non-fatal errors
      if (isAutoChat && event.error !== 'no-speech' && event.error !== 'not-allowed') {
        console.log('Attempting to recover from error...');
        // Clean up before restarting
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop();
          } catch (e) {
            console.log('Error stopping recognition in onerror:', e);
          }
        }
        
        // Add a delay before restarting to prevent rapid reconnection
        setTimeout(() => {
          if (isAutoChat) {
            startListening();
          }
        }, 1000);
      }
    };

    // Start the recognition
    try {
      recognition.start();
      setIsListening(true);
    } catch (e) {
      console.error('Error starting speech recognition:', e);
      // Retry after a delay if it fails
      if (isAutoChat) {
        setTimeout(() => {
          startListening();
        }, 1000);
      }
    }

    try {
      recognition.start();
      setIsListening(true);
    } catch (error) {
      console.error('Error starting speech recognition:', error);
      setIsListening(false);
    }
  }, [isAutoChat]);

  const stopListening = useCallback((): void => {
    if (recognitionRef.current) {
      try {
        // Stop any ongoing recognition
        recognitionRef.current.stop();
      } catch (e) {
        console.log('Error stopping recognition:', e);
      } finally {
        recognitionRef.current = null;
      }
    }
    
    // Clear any pending timeouts
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    
    // Update state
    setIsListening(false);
  }, []);

  const toggleAutoChat = useCallback((): void => {
    const newAutoChatState = !isAutoChat;
    setIsAutoChat(newAutoChatState);
    
    if (newAutoChatState) {
      if (!isListening) {
        startListening();
      }
    } else {
      stopListening();
    }
  }, [isAutoChat, isListening, startListening, stopListening]);

  // Handle auto-chat mode changes
  useEffect(() => {
    if (isAutoChat) {
      // Small delay to ensure clean state before starting
      const timer = setTimeout(() => {
        if (isAutoChat) {
          console.log('Auto-chat enabled, starting listening...');
          startListening();
        }
      }, 300);
      
      return () => {
        console.log('Cleaning up auto-chat...');
        clearTimeout(timer);
        stopListening();
      };
    } else {
      console.log('Auto-chat disabled, stopping...');
      stopListening();
    }
  }, [isAutoChat, startListening, stopListening]);

  useEffect(() => {
    // Cleanup function
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (synthesisRef.current) {
        window.speechSynthesis.cancel();
      }
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isLoading) return;
    
    await processAIResponse(message);
  };

  return (
    <div className="chat-interface">
      <div className="messages-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div>
              <h2>How can I help you today?</h2>
              <p>Ask me anything!</p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`message ${message.sender === 'user' ? 'user-message' : 'ai-message'}`}
            >
              <div className="message-header">
                {message.sender === 'user' ? 'You' : 'AI'}
              </div>
              <div>{message.text}</div>
              <div className="message-time">
                {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="loading-dots">
            <div className="loading-dot"></div>
            <div className="loading-dot"></div>
            <div className="loading-dot"></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="input-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isAutoChat ? "Speak now..." : "Type your message..."}
          className="input-field"
          disabled={isLoading || isAutoChat}
        />
        <button
          type="button"
          className={`icon-button ${isListening ? 'active' : ''}`}
          onClick={isListening ? stopListening : startListening}
          title={isListening ? 'Stop listening' : 'Start voice input'}
        >
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path
              fill="currentColor"
              d={isListening 
                ? "M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z"
                : "M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z"
              }
            />
          </svg>
        </button>
        <button
          type="button"
          className={`icon-button auto-chat-button ${isAutoChat ? 'active' : ''}`}
          onClick={toggleAutoChat}
          title={isAutoChat ? 'Disable auto-chat' : 'Enable auto-chat'}
        >
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path
              fill="currentColor"
              d={isAutoChat 
                ? "M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M10.5,17L6,12.5L7.41,11.09L10.5,14.17L16.59,8L18,9.5L10.5,17Z"
                : "M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"
              }
            />
          </svg>
        </button>
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="send-button"
        >
          Send
        </button>
      </form>
    </div>
  );
};

export default ChatInterface;
