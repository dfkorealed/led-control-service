import { useEffect } from 'react';
import { cleanAbandonedShares } from './src/private-files';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { WebShell } from './src/WebShell';

export default function App() {
  useEffect(() => {
    try { cleanAbandonedShares(); } catch { /* File export reports cache errors when requested; cold start remains usable. */ }
  }, []);
  return <SafeAreaProvider><StatusBar style="dark" /><WebShell webUrl={process.env.EXPO_PUBLIC_WEB_URL} /></SafeAreaProvider>;
}
