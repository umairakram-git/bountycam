// FUNDING.md 2.1: the create form. The location is the same `lat, lon` text as
// before (D122 ruling 2): filled from the phone's position, or typed. Evidence
// items are kept as a list and sent as the same prompts array.
import { useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SpecError, parseCoordinatePair } from '@hackathon/shared';

import { CATEGORIES, PROMPTS_MAX, PROMPT_MAX, type Category } from '../create/defaults';
import type { CreateForm } from '../create/createBounty';
import { currentPosition } from '../scout/location';
import { Button, Header } from './common';
import { JobRules } from './JobRules';
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
  const [typing, setTyping] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | undefined>(undefined);
  const [locationDenied, setLocationDenied] = useState(false);
  const [reward, setReward] = useState('');
  const [prompts, setPrompts] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');

  const parsedLocation = useMemo(() => {
    if (location.trim().length === 0) return undefined;
    try {
      const { lat, lon } = parseCoordinatePair(location);
      return lat + ', ' + lon;
    } catch (error: unknown) {
      return error instanceof SpecError ? 'Not a coordinate pair yet' : String(error);
    }
  }, [location]);

  const useMyLocation = (): void => {
    setLocating(true);
    setLocationNote(undefined);
    setLocationDenied(false);
    currentPosition()
      .then((fix) => {
        if (fix.ok) {
          setLocation(fix.lat + ', ' + fix.lon);
          setLocationNote('Using where you are now.');
        } else if (fix.kind === 'DENIED') {
          setLocationDenied(true);
          setLocationNote('Location access is off. Allow it in Settings, or enter coordinates.');
        } else {
          setLocationNote("Couldn't find your location. Try again, or enter coordinates.");
        }
      })
      .catch(() => setLocationNote("Couldn't find your location. Try again."))
      .finally(() => setLocating(false));
  };

  const addPrompt = (): void => {
    const text = draft.trim();
    if (text.length === 0 || prompts.length >= PROMPTS_MAX) return;
    setPrompts([...prompts, text]);
    setDraft('');
  };

  // An item still in the box counts, so a requester who never taps Add loses nothing.
  const pending = draft.trim();
  const allPrompts =
    pending.length > 0 && prompts.length < PROMPTS_MAX ? [...prompts, pending] : prompts;
  const rewardShown = /^[0-9]+(\.[0-9]{1,6})?$/.test(reward.trim()) ? reward.trim() + ' USDC' : undefined;

  return (
    <View style={styles.screen}>
      <Header title="Create a bounty" onBack={props.onBack} backDisabled={props.busy} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>What do you want checked?</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          maxLength={120}
          placeholder="e.g. Check EV charger"
          placeholderTextColor="#6b6a8f"
        />

        <Text style={styles.label}>Category</Text>
        <View style={styles.chipRow}>
          {CATEGORIES.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityState={{ selected: c === category }}
              onPress={() => setCategory(c)}
              style={[styles.chip, c === category ? styles.chipSelected : null]}
            >
              <Text style={styles.buttonLabel}>{c}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Where</Text>
        <View style={[styles.buttons, { marginTop: 0, marginBottom: 4 }]}>
          <Button
            label={locating ? 'Locating…' : 'Use my location'}
            secondary
            disabled={locating || props.busy}
            onPress={useMyLocation}
          />
          <Button
            label={typing ? 'Hide coordinates' : 'Enter coordinates'}
            secondary
            disabled={props.busy}
            onPress={() => setTyping((value) => !value)}
          />
        </View>
        {typing ? (
          <View>
            <TextInput
              style={styles.input}
              value={location}
              onChangeText={(text) => {
                setLocation(text);
                setLocationNote(undefined);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              placeholder="-33.8688, 151.2093"
              placeholderTextColor="#6b6a8f"
            />
            <Text style={styles.muted}>
              Tip: in Google Maps, long-press the spot and copy the numbers shown.
            </Text>
          </View>
        ) : null}
        {locationNote === undefined ? null : <Text style={styles.muted}>{locationNote}</Text>}
        {locationDenied ? (
          <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()}>
            <Text style={styles.headerActionLabel}>Open Settings</Text>
          </Pressable>
        ) : null}
        {parsedLocation === undefined ? null : (
          <Text style={styles.muted}>{'Pin: ' + parsedLocation}</Text>
        )}

        <Text style={styles.label}>Reward (USDC)</Text>
        <TextInput
          style={styles.input}
          value={reward}
          onChangeText={setReward}
          keyboardType="decimal-pad"
          placeholder="5"
          placeholderTextColor="#6b6a8f"
        />
        <Text style={styles.muted}>
          Held in Solana escrow. Released to the Scout when you approve the evidence, or
          automatically when your review time ends.
        </Text>

        <Text style={styles.label}>
          {'Evidence required (' + String(allPrompts.length) + ' of ' + String(PROMPTS_MAX) + ')'}
        </Text>
        {prompts.length === 0 ? null : (
          <View style={styles.card}>
            {prompts.map((prompt, index) => (
              <View key={String(index) + prompt} style={[styles.cardRow, { marginBottom: 6 }]}>
                <Text style={[styles.value, { flex: 1 }]}>{String(index + 1) + '.  ' + prompt}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={'Remove ' + prompt}
                  disabled={props.busy}
                  onPress={() => setPrompts(prompts.filter((_, i) => i !== index))}
                  style={styles.headerAction}
                >
                  <Text style={styles.toggleLabel}>Remove</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={styles.cardRow}>
          <TextInput
            style={[styles.input, { flex: 1, marginRight: 8 }]}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addPrompt}
            blurOnSubmit={false}
            returnKeyType="done"
            maxLength={PROMPT_MAX}
            placeholder={prompts.length === 0 ? 'e.g. Photo of the charger front' : 'Add another photo'}
            placeholderTextColor="#6b6a8f"
          />
          <Button
            label="Add"
            secondary
            disabled={props.busy || pending.length === 0 || prompts.length >= PROMPTS_MAX}
            onPress={addPrompt}
          />
        </View>

        <Text style={styles.section}>JOB RULES</Text>
        <JobRules />

        {props.notice === undefined ? null : <Text style={styles.notice}>{props.notice}</Text>}

        <View style={styles.buttons}>
          <Button
            label={
              props.busy
                ? 'Creating…'
                : 'Continue to funding' + (rewardShown === undefined ? '' : ' · ' + rewardShown)
            }
            disabled={props.busy}
            onPress={() => props.onSubmit({ title, category, location, reward, prompts: allPrompts })}
          />
        </View>
      </ScrollView>
    </View>
  );
}
