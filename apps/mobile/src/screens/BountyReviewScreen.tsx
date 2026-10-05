// REVIEW.md section 2: the requester's bounty screen. Photos through short-lived URLs that
// are never logged or stored; "Reject by HH:MM"; Approve with one confirm step; Reject
// naming exactly one requirement; then section 5's line and section 6's link.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { apiGet, apiPostEmpty } from '../api/client';
import { approveBounty, rejectBounty, type SettleOutcome } from '../review/settle';
import { outcomeFor, promptOf } from '../review/outcome';
import { readRequirements, readSubmission } from '../scout/evidence';
import { rewardText } from '../scout/views';
import type { WalletProvider } from '../wallet/types';
import { Button } from './common';
import { styles } from './styles';

const REJECT_MARGIN_MS = 30_000;

interface Photo {
  readonly requirementId: string;
  readonly url: string;
}

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function BountyReviewScreen(props: {
  readonly token: string;
  readonly id: string;
  readonly provider: WalletProvider;
  readonly sessionWallet: string;
  readonly onBack: () => void;
}): ReactNode {
  const { token, id } = props;
  const [view, setView] = useState<unknown>(undefined);
  const [photos, setPhotos] = useState<readonly Photo[] | undefined>(undefined);
  const [photosExpire, setPhotosExpire] = useState(0);
  const [photoError, setPhotoError] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'reject' | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const log = useCallback((line: string) => console.log('[review] ' + line), []);

  const loadPhotos = useCallback(async () => {
    setPhotoError(false);
    try {
      const r = await apiGet(token, '/bounties/' + id + '/evidence');
      const ev = get(r.body, 'evidence');
      const items = get(ev, 'items');
      if (r.status !== 200 || !Array.isArray(items)) {
        setPhotoError(true);
        return;
      }
      setPhotos(items.map((it) => ({
        requirementId: String(get(it, 'requirement_id')),
        url: String(get(it, 'url')),
      })));
      setPhotosExpire(Date.parse(String(get(ev, 'expires_at'))));
    } catch {
      setPhotoError(true);
    }
  }, [id, token]);

  const load = useCallback(async () => {
    setNotice(undefined);
    try {
      // Section 8: one settlement report on load, so a silent release or a resolution shows.
      const first = await apiGet(token, '/bounties/' + id);
      let body = first.body;
      const state = get(body, 'state');
      if (first.status === 200 && (state === 'SUBMITTED' || state === 'DISPUTED')) {
        const reported = await apiPostEmpty(token, '/bounties/' + id + '/settlement');
        if (reported.status === 200) body = reported.body;
      }
      if (first.status !== 200) {
        setNotice("Couldn't load this bounty (HTTP " + String(first.status) + ').');
        return;
      }
      setView(body);
      if (readSubmission(body)?.verification === 'VERIFIED') await loadPhotos();
    } catch {
      setNotice("Couldn't reach BountyCam. Try again.");
    }
  }, [id, loadPhotos, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const finish = useCallback(
    (result: SettleOutcome) => {
      if (result.kind === 'DONE') setView(result.view);
      else if (result.kind === 'PENDING') {
        setNotice('Sent. Waiting for the network to confirm; refresh in a moment.');
      } else setNotice(result.message);
      if (result.kind === 'NOT_SENT' && result.detail !== undefined) log(result.detail);
    },
    [log],
  );

  const approve = useCallback(async () => {
    setConfirming(undefined);
    setBusy(true);
    try {
      finish(await approveBounty(props.provider, token, view, props.sessionWallet, log));
    } finally {
      setBusy(false);
    }
  }, [finish, log, props.provider, props.sessionWallet, token, view]);

  const reject = useCallback(async () => {
    if (chosen === undefined) return;
    setConfirming(undefined);
    setChoosing(false);
    setBusy(true);
    try {
      finish(await rejectBounty(props.provider, token, view, chosen, props.sessionWallet, log));
    } finally {
      setBusy(false);
    }
  }, [chosen, finish, log, props.provider, props.sessionWallet, token, view]);

  if (view === undefined) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Bounty</Text>
        <Text style={styles.placeholder}>{notice ?? 'Loading…'}</Text>
        <View style={styles.buttons}>
          <Button label="Back" secondary onPress={props.onBack} />
        </View>
      </View>
    );
  }

  const state = String(get(view, 'state'));
  const submission = readSubmission(view);
  const endsText = get(get(view, 'submission'), 'review_ends_at');
  const endsAt = typeof endsText === 'string' ? Date.parse(endsText) : NaN;
  const outcome = outcomeFor(view, 'requester');
  const requirements = readRequirements(view);
  const reward = rewardText(String(get(get(view, 'policy'), 'reward_amount')));
  const reviewable = state === 'SUBMITTED' && submission?.verification === 'VERIFIED';
  const canReject = reviewable && Number.isFinite(endsAt) && now < endsAt - REJECT_MARGIN_MS;

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{String(get(view, 'title'))}</Text>
      {notice === undefined ? null : <Text style={styles.notice}>{notice}</Text>}
      <ScrollView style={{ flex: 1 }}>
        <Text style={styles.muted}>{state + ' · ' + reward}</Text>
        {outcome === null ? null : (
          <View>
            <Text style={styles.value}>{outcome.line}</Text>
            {outcome.explorerUrl === undefined ? null : (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(outcome.explorerUrl as string)}
              >
                <Text style={styles.label}>View on Solana Explorer</Text>
              </Pressable>
            )}
          </View>
        )}
        {reviewable && Number.isFinite(endsAt) ? (
          <Text style={styles.value}>{'Reject by ' + hhmm(endsAt)}</Text>
        ) : null}
        {photoError ? (
          <View>
            <Text style={styles.notice}>{"Couldn't load the photos."}</Text>
            <Button label="Try again" secondary onPress={() => void loadPhotos()} />
          </View>
        ) : null}
        {(photos ?? []).map((photo) => (
          <View key={photo.requirementId}>
            <Text style={styles.label}>{promptOf(view, photo.requirementId)}</Text>
            <Pressable
              onPress={() => {
                if (Date.now() >= photosExpire) void loadPhotos();
              }}
            >
              <Image
                source={{ uri: photo.url }}
                style={{ width: '100%', aspectRatio: 3 / 4, marginBottom: 8 }}
                resizeMode="contain"
                onError={() => {
                  if (Date.now() >= photosExpire) void loadPhotos();
                }}
              />
            </Pressable>
          </View>
        ))}
        {choosing ? (
          <View>
            <Text style={styles.label}>Which requirement was not met?</Text>
            {requirements.map((r) => (
              <Pressable
                key={r.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: chosen === r.id }}
                onPress={() => setChosen(r.id)}
                style={[styles.chip, chosen === r.id ? styles.chipSelected : null]}
              >
                <Text style={styles.value}>{r.prompt}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {confirming === 'approve' ? (
          <Text style={styles.value}>{'Pay ' + reward + " to the Scout? This can't be undone."}</Text>
        ) : null}
        {confirming === 'reject' && chosen !== undefined ? (
          <Text style={styles.value}>
            {"Reject '" + promptOf(view, chosen) + "'? The arbiter will decide who is paid."}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.buttons}>
        {confirming === 'approve' ? (
          <>
            <Button label="Pay" disabled={busy} onPress={() => void approve()} />
            <Button label="Cancel" secondary disabled={busy} onPress={() => setConfirming(undefined)} />
          </>
        ) : confirming === 'reject' ? (
          <>
            <Button label="Reject" disabled={busy || !canReject} onPress={() => void reject()} />
            <Button label="Cancel" secondary disabled={busy} onPress={() => setConfirming(undefined)} />
          </>
        ) : choosing ? (
          <>
            <Button
              label="Reject"
              disabled={busy || chosen === undefined || !canReject}
              onPress={() => setConfirming('reject')}
            />
            <Button label="Cancel" secondary disabled={busy} onPress={() => setChoosing(false)} />
          </>
        ) : (
          <>
            {reviewable ? (
              <Button label="Approve" disabled={busy} onPress={() => setConfirming('approve')} />
            ) : null}
            {canReject ? (
              <Button label="Reject" secondary disabled={busy} onPress={() => setChoosing(true)} />
            ) : null}
            <Button label="Refresh" secondary disabled={busy} onPress={() => void load()} />
            <Button label="Back" secondary disabled={busy} onPress={props.onBack} />
          </>
        )}
      </View>
    </View>
  );
}
