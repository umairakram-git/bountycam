// FUNDING.md 2.1: the create form. The parsed location is shown under the
// field as the requester types; the reward is converted without a double.
import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView, Text, TextInput, View, Pressable } from 'react-native';
import { SpecError, parseCoordinatePair } from '@hackathon/shared';

import { CATEGORIES, FIXED_LABELS, type Category } from '../create/defaults';
import type { CreateForm } from '../create/createBounty';
import { Button, Field } from './common';
import { styles } from './styles';

export function CreateScreen(props: {
  readonly busy: boolean;
  readonly notice: string | undefined;
  readonly onSubmit: (form: CreateForm) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('Infrastructure');
  const [location, setLocation] = useState('');
  const [reward, setReward] = useState('');
  const [promptsText, setPromptsText] = useState('');

  const parsedLocation = useMemo(() => {
    if (location.trim().length === 0) return 'paste lat, lon from a map app';
    try {
      const { lat, lon } = parseCoordinatePair(location);
      return lat + ', ' + lon;
    } catch (error: unknown) {
      return error instanceof SpecError ? 'not a coordinate pair yet' : String(error);
    }
  }, [location]);

  const prompts = useMemo(
    () => promptsText.split(/\r?\n/).map((p) => p.trim()).filter((p) => p.length > 0),
    [promptsText],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Create a bounty</Text>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} maxLength={120} />

        <Text style={styles.label}>Category</Text>
        <View style={styles.chipRow}>
          {CATEGORIES.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="button"
              onPress={() => setCategory(c)}
              style={[styles.chip, c === category ? styles.chipSelected : null]}
            >
              <Text style={styles.buttonLabel}>{c}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Location (lat, lon)</Text>
        <TextInput
          style={styles.input}
          value={location}
          onChangeText={setLocation}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
        />
        <Text style={styles.muted}>{parsedLocation}</Text>

        <Text style={styles.label}>Reward (USDC)</Text>
        <TextInput
          style={styles.input}
          value={reward}
          onChangeText={setReward}
          keyboardType="decimal-pad"
        />

        <Text style={styles.label}>
          {'Photo prompts, one per line (' + String(prompts.length) + ' of 20)'}
        </Text>
        <TextInput
          style={[styles.input, { minHeight: 100 }]}
          value={promptsText}
          onChangeText={setPromptsText}
          multiline
        />

        {FIXED_LABELS.map(([label, value]) => (
          <Field key={label} label={label} value={value} />
        ))}

        {props.notice === undefined ? null : <Text style={styles.notice}>{props.notice}</Text>}

        <View style={styles.buttons}>
          <Button
            label={props.busy ? 'Creating…' : 'Create'}
            disabled={props.busy}
            onPress={() => props.onSubmit({ title, category, location, reward, prompts })}
          />
          <Button label="Back" secondary disabled={props.busy} onPress={props.onBack} />
        </View>
      </ScrollView>
    </View>
  );
}
