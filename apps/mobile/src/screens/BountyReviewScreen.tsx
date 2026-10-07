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
import { Button, Header, StatusPill } from './common';
import { stateLabel } from './MyBountiesScreen';
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
  const [enlarged, setEnlarged] = useState<string | undefined>(undefined);
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
        <Header title="Bounty" onBack={props.onBack} />
        <Text style={styles.muted}>{notice ?? 'Loading…'}</Text>
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
  const kind = get(get(view, 'settlement'), 'kind');
  const verified = submission?.verification === 'VERIFIED';
  const paid = state === 'PAID';
  const howPaid =
    kind === 'APPROVED'
      ? 'You approved the evidence.'
      : kind === 'RELEASED'
        ? 'Released automatically after your review time.'
        : kind === 'RESOLVED_PAID'
          ? 'The arbiter paid the Scout.'
          : undefined;
  const received = photos?.length ?? submission?.itemCount;

  return (
    <View style={styles.screen}>
      <Header
        title={String(get(view, 'title'))}
        onBack={props.onBack}
        backDisabled={busy}
        action={{ label: 'Refresh', onPress: () => void load(), disabled: busy }}
      />
      {notice === undefined ? null : <Text style={styles.notice}>{notice}</Text>}
      <ScrollView style={{ flex: 1 }}>
        <View style={[styles.cardRow, { marginBottom: 8 }]}>
          <StatusPill {...stateLabel(state)} />
          <Text style={styles.reward}>{reward}</Text>
        </View>

        {paid ? (
          <View style={[styles.card, { borderColor: '#2f6b4c' }]}>
            {verified ? <Text style={styles.meta}>✓ Evidence verified</Text> : null}
            <Text style={styles.rewardLarge}>{reward + ' released'}</Text>
            <Text style={styles.muted}>{'Paid to the Scout. ' + (howPaid ?? '')}</Text>
            {verified && received !== undefined && received >= requirements.length ? (
              <Text style={styles.value}>
                {requirements.length === 1
                  ? '✓ Required photo received'
                  : '✓ All ' + String(requirements.length) + ' required photos received'}
              </Text>
            ) : null}
            {verified ? (
              <Text style={styles.value}>{"✓ Checked against this bounty's rules"}</Text>
            ) : null}
            {outcome?.explorerUrl === undefined ? null : (
              <View>
                <Text style={styles.value}>✓ Settled on Solana</Text>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(outcome.explorerUrl as string)}
                  style={{ paddingVertical: 8 }}
                >
                  <Text style={styles.headerActionLabel}>View transaction ›</Text>
                </Pressable>
              </View>
            )}
          </View>
        ) : outcome === null ? null : (
          <View style={styles.card}>
            <Text style={styles.value}>{outcome.line}</Text>
            {outcome.explorerUrl === undefined ? null : (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(outcome.explorerUrl as string)}
                style={{ paddingVertical: 8 }}
              >
                <Text style={styles.headerActionLabel}>View transaction ›</Text>
              </Pressable>
            )}
          </View>
        )}

        {reviewable ? (
          <View style={styles.card}>
            <Text style={styles.value}>
              {'✓ Evidence verified. Check the ' +
                (requirements.length === 1 ? 'photo' : 'photos') + ', then approve.'}
            </Text>
            {Number.isFinite(endsAt) ? (
              <Text style={styles.muted}>
                {'Reject by ' + hhmm(endsAt) +
                  '. If you do nothing, payment releases automatically after that.'}
              </Text>
            ) : null}
          </View>
        ) : null}

        {photos === undefined && !photoError ? null : (
          <Text style={styles.section}>
            {'EVIDENCE' + (received === undefined ? '' : ' ' + String(received) + '/' +
              String(requirements.length))}
          </Text>
        )}
        {photoError ? (
          <View>
            <Text style={styles.notice}>{"Couldn't load the photos."}</Text>
            <Button label="Try again" secondary onPress={() => void loadPhotos()} />
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(photos ?? []).map((photo) => {
            const big = enlarged === photo.requirementId;
            return (
              <Pressable
                key={photo.requirementId}
                accessibilityRole="imagebutton"
                accessibilityLabel={promptOf(view, photo.requirementId) + (big ? ', tap to shrink' : ', tap to enlarge')}
                onPress={() => {
                  if (Date.now() >= photosExpire) void loadPhotos();
                  setEnlarged(big ? undefined : photo.requirementId);
                }}
                style={[styles.card, { padding: 8, marginBottom: 0, width: big ? '100%' : '48%' }]}
              >
                <Image
                  source={{ uri: photo.url }}
                  style={{ width: '100%', aspectRatio: 3 / 4, borderRadius: 8 }}
                  resizeMode={big ? 'contain' : 'cover'}
                  onError={() => {
                    if (Date.now() >= photosExpire) void loadPhotos();
                  }}
                />
                <Text style={[styles.muted, { marginTop: 6 }]} numberOfLines={big ? undefined : 2}>
                  {promptOf(view, photo.requirementId)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {choosing ? (
          <View>
            <Text style={styles.section}>WHICH REQUIREMENT WAS NOT MET?</Text>
            {requirements.map((r) => (
              <Pressable
                key={r.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: chosen === r.id }}
                onPress={() => setChosen(r.id)}
                style={[styles.chip, { marginBottom: 8 }, chosen === r.id ? styles.chipSelected : null]}
              >
                <Text style={styles.value}>{r.prompt}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {confirming === 'approve' ? (
          <Text style={[styles.value, { marginTop: 12 }]}>
            {'Pay ' + reward + " to the Scout? This can't be undone."}
          </Text>
        ) : null}
        {confirming === 'reject' && chosen !== undefined ? (
          <Text style={[styles.value, { marginTop: 12 }]}>
            {"Reject '" + promptOf(view, chosen) + "'? The arbiter will decide who is paid."}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.buttons}>
        {confirming === 'approve' ? (
          <>
            <Button label={'Pay ' + reward} disabled={busy} onPress={() => void approve()} />
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
              <Button
                label={'Approve · Pay ' + reward}
                disabled={busy}
                onPress={() => setConfirming('approve')}
              />
            ) : null}
            {canReject ? (
              <Button label="Reject" secondary disabled={busy} onPress={() => setChoosing(true)} />
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
