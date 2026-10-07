// FUNDING.md 2.4: GET /me/bounties; on load, one report per DRAFT row so a
// lost report is picked up when its requester looks; Fund and Cancel on DRAFT.
// CAPTURE.md 7.9: an ACCEPTED bounty's owner view says whether evidence arrived,
// and nothing else about it (D138 ruling 5).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { apiGet, apiPostEmpty } from '../api/client';
import { formatUsdc } from '../create/createBounty';
import { FIXED_POLICY } from '../create/defaults';
import { readSubmission, type SubmissionSummary } from '../scout/evidence';
import { Button, Header, StatusPill, type PillTone } from './common';
import { styles } from './styles';

export interface ListItem {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly reward_amount: string;
  readonly created_at: string;
}

// REVIEW.md section 2: the states with a review, a dispute or a settlement to show.
const OPENABLE: ReadonlySet<string> = new Set(['SUBMITTED', 'DISPUTED', 'PAID', 'REFUNDED']);

function rewardText(baseUnits: string): string {
  return /^[0-9]+$/.test(baseUnits) ? formatUsdc(BigInt(baseUnits)) : baseUnits;
}

/** The words and colour each bounty state is shown with. */
export function stateLabel(state: string): { readonly label: string; readonly tone: PillTone } {
  switch (state) {
    case 'DRAFT':
      return { label: 'Not funded', tone: 'grey' };
    case 'AVAILABLE':
      return { label: 'Available', tone: 'accent' };
    case 'ACCEPTED':
      return { label: 'Accepted', tone: 'amber' };
    case 'SUBMITTED':
      return { label: 'In review', tone: 'amber' };
    case 'DISPUTED':
      return { label: 'Disputed', tone: 'red' };
    case 'PAID':
      return { label: 'Paid', tone: 'green' };
    case 'REFUNDED':
      return { label: 'Refunded', tone: 'grey' };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'grey' };
    default:
      return { label: state, tone: 'grey' };
  }
}

// An open bounty past its acceptance window stays AVAILABLE on the server until
// expire_unaccepted runs (BACKLOG); Scouts no longer see it, so it is shown as expired.
// The window runs from funding, a little after created_at, so this can read early by
// those minutes; an acceptance then shows as ACCEPTED on the next load.
function isExpired(item: ListItem): boolean {
  const t = Date.parse(item.created_at);
  return (
    item.state === 'AVAILABLE' &&
    Number.isFinite(t) &&
    Date.now() > t + FIXED_POLICY.acceptance_window_seconds * 1000
  );
}

function ago(iso: string): string | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (min < 1) return 'Posted just now';
  if (min < 60) return 'Posted ' + String(min) + ' min ago';
  const h = Math.round(min / 60);
  if (h < 24) return 'Posted ' + String(h) + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return 'Posted ' + String(d) + (d === 1 ? ' day ago' : ' days ago');
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function asItems(body: unknown): ListItem[] {
  const list = (body as { bounties?: unknown }).bounties;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const r = raw as Partial<ListItem>;
    return {
      id: String(r.id),
      title: String(r.title),
      state: String(r.state),
      reward_amount: String(r.reward_amount),
      created_at: String(r.created_at),
    };
  });
}

export function MyBountiesScreen(props: {
  readonly token: string;
  readonly busy: boolean;
  readonly onFund: (id: string) => void;
  /** REVIEW.md section 2: the bounty screen, for SUBMITTED onward. */
  readonly onOpen: (id: string) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [items, setItems] = useState<readonly ListItem[] | undefined>(undefined);
  const [received, setReceived] = useState<Record<string, SubmissionSummary>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const { token } = props;

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const first = await apiGet(token, '/me/bounties');
      if (first.status !== 200) {
        setError('Could not load your bounties (HTTP ' + String(first.status) + ').');
        return;
      }
      const drafts = asItems(first.body).filter((i) => i.state === 'DRAFT');
      // POLICY.md 15.4: one report per DRAFT, results ignored here; the reload
      // below shows whatever the server now says.
      for (const d of drafts) {
        try {
          await apiPostEmpty(token, '/bounties/' + d.id + '/funding');
        } catch {
          // The list still loads; the next open reports again.
        }
      }
      const second = drafts.length === 0 ? first : await apiGet(token, '/me/bounties');
      const listed = asItems(second.body);
      setItems(listed);
      // Sections 7.9 and 8.2: ACCEPTED and SUBMITTED owner views carry `submission`.
      const found: Record<string, SubmissionSummary> = {};
      for (const item of listed.filter((i) => i.state === 'ACCEPTED' || i.state === 'SUBMITTED')) {
        try {
          const detail = await apiGet(token, '/bounties/' + item.id);
          const summary = detail.status === 200 ? readSubmission(detail.body) : null;
          if (summary !== null) found[item.id] = summary;
        } catch {
          // The list still shows; the next refresh asks again.
        }
      }
      setReceived(found);
    } catch (error: unknown) {
      setError('Could not reach the server: ' + String(error));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // POLICY.md 8.7 and 15.6: no body; a funded bounty answers 409 and the
  // reload shows it AVAILABLE.
  const cancel = useCallback(
    async (id: string) => {
      setCancelling(true);
      try {
        const result = await apiPostEmpty(token, '/bounties/' + id + '/cancel');
        if (result.status !== 200) {
          setError('Cancel answered HTTP ' + String(result.status) + '.');
        }
      } catch (error: unknown) {
        setError('Could not reach the server: ' + String(error));
      } finally {
        setCancelling(false);
      }
      await load();
    },
    [load, token],
  );

  const busy = props.busy || cancelling;

  return (
    <View style={styles.screen}>
      <Header
        title="My bounties"
        onBack={props.onBack}
        backDisabled={busy}
        action={{ label: 'Refresh', onPress: () => void load(), disabled: busy }}
      />
      {error === undefined ? null : <Text style={styles.notice}>{error}</Text>}
      <ScrollView>
        {items === undefined ? (
          <Text style={styles.placeholder}>Loading…</Text>
        ) : items.length === 0 ? (
          <Text style={styles.muted}>No bounties yet. Create one from the home screen.</Text>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole={OPENABLE.has(item.state) ? 'button' : undefined}
              disabled={!OPENABLE.has(item.state) || busy}
              onPress={() => props.onOpen(item.id)}
              style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
            >
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.reward}>{rewardText(item.reward_amount) + ' USDC'}</Text>
              </View>
              <View style={[styles.cardRow, { marginTop: 8, marginBottom: 4 }]}>
                <StatusPill
                  {...(isExpired(item) ? { label: 'Expired', tone: 'grey' as const } : stateLabel(item.state))}
                />
                <Text style={styles.muted}>{ago(item.created_at) ?? ''}</Text>
              </View>
              {isExpired(item) ? <Text style={styles.muted}>No Scout took it.</Text> : null}
              {received[item.id] === undefined ? null : received[item.id]!.verification ===
                'NOT_VERIFIED' ? (
                <Text style={styles.value}>
                  {"Evidence couldn't be verified. Your USDC returns after the deadline."}
                </Text>
              ) : (
                <View>
                  <Text style={styles.value}>
                    {received[item.id]!.verification === 'VERIFIED'
                      ? 'Evidence verified.'
                      : 'Evidence received, being checked.'}
                  </Text>
                  <Text style={styles.muted}>
                    {'Submitted ' + hhmm(received[item.id]!.submittedAt) + ' · ' +
                      String(received[item.id]!.itemCount) + ' photos'}
                  </Text>
                </View>
              )}
              {OPENABLE.has(item.state) ? (
                <Text style={styles.headerActionLabel}>
                  {item.state === 'SUBMITTED' ? 'Review evidence ›' : 'View result ›'}
                </Text>
              ) : null}
              {item.state === 'DRAFT' ? (
                <View style={styles.chipRow}>
                  <Button label="Fund" disabled={busy} onPress={() => props.onFund(item.id)} />
                  <Button
                    label="Cancel"
                    secondary
                    disabled={busy}
                    onPress={() => void cancel(item.id)}
                  />
                </View>
              ) : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}
