// CAPTURE.md sections 3 to 5: the Start capture button, its failure messages,
// the restart warning, the countdown and recovery. The server decides every
// time; the phone shows the server's clock as its own clock plus an offset
// measured on each response (D132). Section 7's photos are EvidenceSection's;
// this section owns the view, and shows the submitted state (section 7.7).
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { checkCaptureStart } from '@hackathon/shared';

import { apiGet, apiPost, errorCodeOf } from '../api/client';
import {
  judgedLine,
  mmss,
  readCapture,
  startBody,
  takeStartFix,
  type CaptureState,
  type StartFix,
} from '../scout/capture';
import { readSubmission, type SubmissionSummary } from '../scout/evidence';
import type { WalletProvider } from '../wallet/types';
import { Button } from './common';
import { EvidenceSection } from './EvidenceSection';
import { styles } from './styles';

type Action = 'settings' | 'retry' | 'missions' | undefined;

interface Message {
  readonly text: string;
  readonly detail?: string;
  readonly action?: Action;
}

const MESSAGES = {
  denied: 'BountyCam needs your location to start capture. Open Settings to allow it.',
  servicesOff: 'Location is turned off. Turn it on in Settings to start capture.',
  noFix: "Couldn't get your location. Move near a window or outside, then try again.",
  imprecise: "Your location isn't precise enough yet. Move near a window or outside, then " +
    'try again.',
  tooLate: "It's too late to start capture on this mission.",
  gone: 'This mission can no longer be captured.',
  unreachable: "Couldn't reach BountyCam. Check your connection and try again.",
  started: 'Capture started. Take your photos before the timer ends.',
  // Section 7.2: said before any session exists (POLICY.md 17.9, D138 ruling 1).
  connection: 'Start needs a connection. After you start, photos can be taken with weak ' +
    'signal; they upload when it returns, until the upload deadline.',
  warning: 'Starting again will discard the photos from your current capture.',
  // The server's own too-far answer carries no distance; it is rare, because
  // the server runs the same function on the same fix (section 4).
  farServer: "You're too far from the mission spot. Move closer, then try again.",
} as const;

function tooFar(distanceM: number): string {
  return "You're about " + String(Math.round(distanceM)) + ' m from the mission spot. ' +
    'Move closer, then try again.';
}

export function CaptureSection(props: {
  readonly token: string;
  readonly bountyId: string;
  readonly lat: string;
  readonly lon: string;
  readonly radiusM: number;
  readonly onMissions: () => void;
  readonly provider: WalletProvider;
  readonly view: unknown;
  readonly scoutWallet: string;
}): ReactNode {
  const [capture, setCapture] = useState<CaptureState | undefined>(undefined);
  const [view, setView] = useState<unknown>(props.view);
  const [submission, setSubmission] = useState<SubmissionSummary | null>(
    readSubmission(props.view),
  );
  const offset = useRef(0);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<StartFix | undefined>(undefined);
  const [, setTick] = useState(0);
  const serverNow = (): number => Date.now() + offset.current;

  const adopt = useCallback((raw: unknown, receivedAt: number): CaptureState | undefined => {
    const state = readCapture(raw);
    if (state === undefined) return undefined;
    offset.current = state.serverTime - receivedAt;
    setCapture(state);
    return state;
  }, []);

  // Section 4's recovery and section 5's restore: the view is the authority.
  const reload = useCallback(async (): Promise<CaptureState | undefined> => {
    const result = await apiGet(props.token, '/bounties/' + props.bountyId);
    const received = Date.now();
    if (result.status !== 200) return undefined;
    setView(result.body);
    setSubmission(readSubmission(result.body));
    return adopt((result.body as { capture?: unknown } | undefined)?.capture, received);
  }, [adopt, props.bountyId, props.token]);

  useEffect(() => {
    reload().catch(() => setMessage({ text: MESSAGES.unreachable, action: 'retry' }));
  }, [reload]);

  // A one-second tick drives the countdown while a session is live.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const request = useCallback(
    async (fix: StartFix) => {
      setPending(undefined);
      setBusy(true);
      try {
        const result = await apiPost(
          props.token,
          '/bounties/' + props.bountyId + '/capture-nonce',
          startBody(fix),
        );
        const received = Date.now();
        const code = errorCodeOf(result.body);
        if (result.status === 201) {
          const state = adopt((result.body as { capture?: unknown }).capture, received);
          if (state !== undefined) {
            setMessage({ text: MESSAGES.started });
            return;
          }
        } else if (code === 'LOCATION_TOO_IMPRECISE') {
          setMessage({ text: MESSAGES.imprecise, action: 'retry' });
          return;
        } else if (code === 'LOCATION_TOO_FAR') {
          setMessage({ text: MESSAGES.farServer, action: 'retry' });
          return;
        } else if (code === 'CAPTURE_WINDOW_CLOSED') {
          setMessage({ text: MESSAGES.tooLate });
          return;
        } else if (
          code === 'BOUNTY_NOT_CAPTURABLE' || code === 'NOT_ASSIGNED' || code === 'NOT_FOUND'
        ) {
          setMessage({ text: MESSAGES.gone, action: 'missions' });
          return;
        }
        setMessage({ text: MESSAGES.unreachable, action: 'retry' });
        await reload();
      } catch {
        setMessage({ text: MESSAGES.unreachable, action: 'retry' });
        await reload().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [adopt, props.bountyId, props.token, reload],
  );

  const onStart = useCallback(async () => {
    if (capture === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const taken = await takeStartFix(capture.fixTimeoutS, capture.maxAgeS);
      if (!taken.ok) {
        if (taken.kind === 'NO_FIX') {
          setMessage({
            text: MESSAGES.noFix,
            detail: judgedLine(taken.accuracyM, undefined, taken.ageS),
            action: 'retry',
          });
        } else if (taken.kind === 'DENIED') {
          setMessage({ text: MESSAGES.denied, action: 'settings' });
        } else {
          setMessage({ text: MESSAGES.servicesOff, action: 'settings' });
        }
        return;
      }
      const gate = checkCaptureStart(
        taken.fix,
        { lat: props.lat, lon: props.lon },
        props.radiusM,
        capture.maxAccuracyM,
      );
      const detail = judgedLine(taken.fix.accuracyM, gate.distanceM, taken.ageS);
      if (gate.decision === 'IMPRECISE') {
        setMessage({ text: MESSAGES.imprecise, detail, action: 'retry' });
        return;
      }
      if (gate.decision === 'TOO_FAR') {
        setMessage({ text: tooFar(gate.distanceM), detail, action: 'retry' });
        return;
      }
      const live = capture.nonce !== null && serverNow() < capture.nonce.expiresAt;
      if (live) {
        setPending(taken.fix);
        return;
      }
      await request(taken.fix);
    } finally {
      setBusy(false);
    }
  }, [capture, props.lat, props.lon, props.radiusM, request]);

  if (capture === undefined) {
    return (
      <View>
        <Text style={styles.muted}>Loading capture…</Text>
        {message === undefined ? null : <Text style={styles.notice}>{message.text}</Text>}
        {message?.action === 'retry' ? (
          <Button label="Try again" onPress={() => void reload()} />
        ) : null}
      </View>
    );
  }

  // Section 7.7: after submission, only the submitted state; section 8.1 by verification.
  if (submission !== null) {
    const at = new Date(submission.submittedAt);
    const hhmm = String(at.getHours()).padStart(2, '0') + ':' +
      String(at.getMinutes()).padStart(2, '0');
    const line =
      submission.verification === 'VERIFIED'
        ? "Evidence verified. Waiting for the requester's review."
        : submission.verification === 'NOT_VERIFIED'
          ? "Your evidence couldn't be verified, so this bounty won't pay."
          : 'Evidence submitted at ' + hhmm + ' · ' + String(submission.itemCount) +
            " photos. The requester's review comes next.";
    return (
      <View>
        <Text style={styles.label}>Capture</Text>
        <Text style={styles.value}>{line}</Text>
      </View>
    );
  }

  const now = serverNow();
  const live = capture.nonce !== null && now < capture.nonce.expiresAt;
  const open = now <= capture.startClosesAt;

  return (
    <View>
      <Text style={styles.label}>Capture</Text>
      {live && capture.nonce !== null ? (
        <Text style={styles.value}>
          {MESSAGES.started + ' ' + mmss(capture.nonce.expiresAt - now) + ' left.'}
        </Text>
      ) : null}
      {capture.nonce === null && open ? (
        <Text style={styles.muted}>{MESSAGES.connection}</Text>
      ) : null}
      {!open ? <Text style={styles.notice}>{MESSAGES.tooLate}</Text> : null}
      {message !== undefined && message.text !== MESSAGES.started ? (
        <Text style={styles.notice}>{message.text}</Text>
      ) : null}
      {message?.detail !== undefined && message.detail !== '' ? (
        <Text style={styles.muted}>{message.detail}</Text>
      ) : null}
      {pending !== undefined ? (
        <View>
          <Text style={styles.notice}>{MESSAGES.warning}</Text>
          <View style={styles.buttons}>
            <Button label="Start again" disabled={busy} onPress={() => void request(pending)} />
            <Button label="Cancel" secondary onPress={() => setPending(undefined)} />
          </View>
        </View>
      ) : null}
      <View style={styles.buttons}>
        {open && pending === undefined ? (
          <Button
            label={live ? 'Start again' : 'Start capture'}
            disabled={busy}
            onPress={() => void onStart()}
          />
        ) : null}
        {message?.action === 'settings' ? (
          <Button label="Open Settings" secondary onPress={() => void Linking.openSettings()} />
        ) : null}
        {message?.action === 'missions' ? (
          <Button label="Back to My missions" secondary onPress={props.onMissions} />
        ) : null}
      </View>
      <EvidenceSection
        token={props.token}
        provider={props.provider}
        view={view}
        scoutWallet={props.scoutWallet}
        nonce={capture.nonce}
        maxAccuracyM={capture.maxAccuracyM}
        maxAgeS={capture.maxAgeS}
        target={{ lat: props.lat, lon: props.lon }}
        radiusM={props.radiusM}
        serverNow={serverNow}
        onReload={async () => {
          await reload();
        }}
      />
    </View>
  );
}
