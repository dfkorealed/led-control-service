import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export function RecoveryState({ title, message, testID, retry, loading = false }: { title: string; message: string; testID: string; retry?: () => void; loading?: boolean }) {
  return <View testID={testID} style={styles.container} accessibilityLiveRegion="polite">
    {loading && <ActivityIndicator size="large" color="#1565c0" />}
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    <Text style={styles.message}>{message}</Text>
    {retry && <Pressable testID="retry-connection" accessibilityRole="button" onPress={retry} style={styles.button}><Text style={styles.buttonLabel}>다시 시도</Text></Pressable>}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f7fb', gap: 16 },
  title: { fontSize: 22, fontWeight: '600', textAlign: 'center', color: '#18283b' },
  message: { fontSize: 16, lineHeight: 24, textAlign: 'center', color: '#526176' },
  button: { minHeight: 48, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, backgroundColor: '#1565c0' },
  buttonLabel: { fontSize: 16, fontWeight: '600', color: '#fff' }
});
