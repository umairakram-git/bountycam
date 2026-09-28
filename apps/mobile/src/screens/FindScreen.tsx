// DISCOVERY.md 3.1: one location fix, one discovery query, a list.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { apiGet } from '../api/client';
import { DISCOVERY_LIMIT, DISCOVERY_RADIUS_M } from '../config';
import { aboutKm, currentPosition } from '../scout/location';
import { asSummaries, rewardText, type BountySummary, type Point } from '../scout/views';
import { Button } from './common';
import { styles } from './styles';

export function FindScreen(props: {
  readonly token: string;
  readonly onOpen: (id: string, position: Point | undefined) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [items, setItems] = useState<readonly BountySummary[] | undefined>(undefined);
  const [position, setPosition] = useState<Point | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [denied, setDenied] = useState(false);
  const { token } = props;

  const load = useCallback(async () => {
    setNotice(undefined);
    setDenied(false);
    setItems(undefined);
    const fix = await currentPosition();
    if (!fix.ok) {
      if (fix.kind === 'DENIED') {
        setDenied(true);
        setNotice(
          'BountyCam needs your location to find bounties near you. Open Settings to allow it.',
        );
      } else {
        setNotice("Couldn't find your location. Try again.");
      }
      return;
    }
    setPosition(fix.point);
    try {
      const path =
        '/bounties?lat=' + fix.lat + '&lon=' + fix.lon +
        '&radius_m=' + String(DISCOVERY_RADIUS_M) + '&limit=' + String(DISCOVERY_LIMIT);
      const result = await apiGet(token, path);
      if (result.status !== 200) {
        setNotice("Couldn't load bounties (HTTP " + String(result.status) + ').');
        return;
      }
      setItems(asSummaries(result.body, 'bounties'));
    } catch {
      setNotice("Couldn't reach BountyCam. Try again.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Bounties near you</Text>
      {notice === undefined ? null : <Text style={styles.notice}>{notice}</Text>}
      {items === undefined && notice === undefined ? (
        <Text style={styles.muted}>Finding your location…</Text>
      ) : null}
      {items !== undefined && items.length === 0 ? (
        <Text style={styles.muted}>No bounties near you right now.</Text>
      ) : null}
      <ScrollView style={{ flex: 1 }}>
        {(items ?? []).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            onPress={() => props.onOpen(item.id, position)}
            style={styles.row}
          >
            <Text style={styles.value}>{item.title}</Text>
            <Text style={styles.muted}>
              {item.category + ' · ' + rewardText(item.rewardAmount) + ' · ' +
                (aboutKm(position, item.area) ?? '')}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.buttons}>
        {denied ? (
          <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
        ) : null}
        <Button label="Refresh" onPress={() => void load()} />
        <Button label="Back" secondary onPress={props.onBack} />
      </View>
    </View>
  );
}
