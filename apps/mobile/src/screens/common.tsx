// Small pieces every screen uses: a button, a header, a status pill, a log pane
// behind a "Technical details" toggle, and a key–value line.
import { useState, type ReactNode } from 'react';
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

/** A screen header: a small back arrow, the title, and an optional action on the right. */
export function Header(props: {
  readonly title: string;
  readonly onBack?: () => void;
  readonly backDisabled?: boolean;
  readonly action?: { readonly label: string; readonly onPress: () => void; readonly disabled?: boolean };
}): ReactNode {
  return (
    <View style={styles.header}>
      {props.onBack === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          disabled={props.backDisabled === true}
          onPress={props.onBack}
          style={({ pressed }) => [styles.headerBack, pressed ? styles.buttonPressed : null]}
        >
          <Text style={styles.headerBackLabel}>‹</Text>
        </Pressable>
      )}
      <Text style={styles.headerTitle} numberOfLines={1}>
        {props.title}
      </Text>
      {props.action === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.action.label}
          disabled={props.action.disabled === true}
          onPress={props.action.onPress}
          style={({ pressed }) => [styles.headerAction, pressed ? styles.buttonPressed : null]}
        >
          <Text style={styles.headerActionLabel}>{props.action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

export type PillTone = 'accent' | 'amber' | 'green' | 'grey' | 'red';

const PILL_COLOURS: Record<PillTone, { readonly bg: string; readonly fg: string }> = {
  accent: { bg: '#2a2560', fg: '#c4bcff' },
  amber: { bg: '#3d3014', fg: '#ffd166' },
  green: { bg: '#123824', fg: '#6ee7a8' },
  grey: { bg: '#2a2a45', fg: '#b4b3cf' },
  red: { bg: '#3d1820', fg: '#ff9aa8' },
};

export function StatusPill(props: { readonly label: string; readonly tone: PillTone }): ReactNode {
  const colour = PILL_COLOURS[props.tone];
  return (
    <View style={[styles.pill, { backgroundColor: colour.bg }]}>
      <Text style={[styles.pillLabel, { color: colour.fg }]}>{props.label.toUpperCase()}</Text>
    </View>
  );
}

/** "7x9A…pAK2": a wallet address short enough to read. */
export function shortWallet(address: string): string {
  return address.length <= 10 ? address : address.slice(0, 4) + '…' + address.slice(-4);
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

/** The log pane, closed by default. Kept for diagnosing live runs. */
export function TechnicalDetails(props: { readonly lines: readonly string[] }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <View style={open ? { flex: 1 } : null}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide technical details' : 'Show technical details'}
        onPress={() => setOpen((value) => !value)}
        style={styles.toggle}
      >
        <Text style={styles.toggleLabel}>{(open ? '▾ ' : '▸ ') + 'Technical details'}</Text>
      </Pressable>
      {open ? <LogPane lines={props.lines} /> : null}
    </View>
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
