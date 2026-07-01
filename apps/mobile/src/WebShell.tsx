import { SafeAreaView, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

interface WebShellProps {
  webUrl: string;
}

export function WebShell({ webUrl }: WebShellProps) {
  return (
    <SafeAreaView style={styles.container}>
      <WebView testID="control-webview" source={{ uri: webUrl }} sharedCookiesEnabled />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff"
  }
});
