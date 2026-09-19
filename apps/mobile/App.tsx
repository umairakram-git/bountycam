// Session 12 SIWS sign-in screen. One button, one log pane.
//
// What the log may carry: the SIWS message and its signature are public by
// construction — the wallet hands them over to be sent to a server that will
// publish nothing but a yes or no, and they are exactly the evidence this
// session exists to collect (AUTH.md 14.2). What it may never carry: the JWT,
// which is a bearer credential, and any key material. Nothing below prints
// either, and the raw verify body is deliberately not printed on the success
// path because the token is inside it.

import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { runSiwsSignIn, type SignInOutcome } from './src/auth/signIn';
import { createMwaWalletProvider } from './src/wallet/mwa';

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return String(error);
}

function describeOutcome(outcome: SignInOutcome): string {
  if (outcome.ok) {
    return (
      'RESULT: success (HTTP ' +
      String(outcome.status) +
      ') — user ' +
      outcome.user.id +
      ', wallet ' +
      outcome.user.wallet_address +
      ', status ' +
      outcome.user.status +
      '. Token received and not logged.'
    );
  }
  const status = outcome.status === undefined ? 'no response' : 'HTTP ' + String(outcome.status);
  const code = outcome.errorCode ?? 'none';
  return (
    'RESULT: failed at ' +
    outcome.stage +
    ' — ' +
    status +
    ', error code: ' +
    code +
    ' — ' +
    outcome.message
  );
}

export default function App() {
  const provider = useMemo(() => createMwaWalletProvider(), []);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const append = useCallback((line: string) => {
    setLines((previous) => [...previous, line]);
  }, []);

  const onSignIn = useCallback(() => {
    setBusy(true);
    provider.disconnect();
    append('=== sign-in run ' + new Date().toISOString() + ' ===');
    runSiwsSignIn(provider, append)
      .then((outcome) => {
        append(describeOutcome(outcome));
      })
      .catch((error: unknown) => {
        // Nothing is caught into a retry, and nothing is caught into silence.
        append('UNCAUGHT: ' + describeThrown(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [append, provider]);

  const onClear = useCallback(() => {
    setLines([]);
  }, []);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>BountyCam — SIWS on device</Text>

      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onSignIn}
          style={({ pressed }) => [
            styles.button,
            busy ? styles.buttonDisabled : null,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonLabel}>
            {busy ? 'Signing in…' : 'Sign in with wallet'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={onClear}
          style={({ pressed }) => [
            styles.button,
            styles.buttonSecondary,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonLabel}>Clear</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {lines.length === 0 ? (
          <Text style={styles.placeholder}>No output yet.</Text>
        ) : (
          lines.map((line, index) => (
            <Text key={String(index) + ':' + line} selectable style={styles.line}>
              {line}
            </Text>
          ))
        )}
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#12131a',
    paddingTop: 56,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  title: {
    color: '#e7e9f0',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#3f6ae0',
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  buttonSecondary: {
    backgroundColor: '#3a3d4a',
  },
  buttonDisabled: {
    backgroundColor: '#2c3350',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  log: {
    flex: 1,
    backgroundColor: '#0b0c11',
    borderColor: '#2a2d38',
    borderRadius: 6,
    borderWidth: 1,
  },
  logContent: {
    padding: 10,
  },
  placeholder: {
    color: '#6b7080',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  line: {
    color: '#d6dae6',
    fontFamily: 'monospace',
    fontSize: 12,
    marginBottom: 6,
  },
});
