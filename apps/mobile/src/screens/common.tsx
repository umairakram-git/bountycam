// Small pieces every screen uses: a button, a log pane, a key–value line.
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { styles } from './styles';

export function Button(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly secondary?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.secondary === true ? styles.buttonSecondary : null,
        props.disabled === true ? styles.buttonDisabled : null,
        pressed ? styles.buttonPressed : null,
      ]}
    >
      <Text style={styles.buttonLabel}>{props.label}</Text>
    </Pressable>
  );
}

export function LogPane(props: { readonly lines: readonly string[] }): ReactNode {
  return (
    <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
      {props.lines.length === 0 ? (
        <Text style={styles.placeholder}>No output yet.</Text>
      ) : (
        props.lines.map((line, index) => (
          <Text key={String(index) + ':' + line} selectable style={styles.line}>
            {line}
          </Text>
        ))
      )}
    </ScrollView>
  );
}

export function Field(props: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <View>
      <Text style={styles.label}>{props.label}</Text>
      <Text selectable style={styles.value}>
        {props.value}
      </Text>
    </View>
  );
}
