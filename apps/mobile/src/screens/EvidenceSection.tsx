// CAPTURE.md sections 7.2 to 7.7 (P4): the checklist, the camera, the shutter's checks,
// upload with retry, the signed submission, and expiry. Photos live in the app's cache for
// the session only, their records in memory; the server decides every time (D132), read here
// through `serverNow`.
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { checkCaptureStart, type EvidenceItem } from '@hackathon/shared';

import type { CaptureNonce } from '../scout/capture';
import { judgedLine } from '../scout/capture';
import {
  buildManifest,
  deletePhoto,
  hashPhoto,
  readHeaderParts,
  readRequirements,
  retryDelayMs,
  shutterRecord,
  submitEvidence,
  uploadOnce,
  type Fix,
} from '../scout/evidence';
import type { WalletProvider } from '../wallet/types';
import { Button } from './common';
import { styles } from './styles';

type Status = 'NOT_TAKEN' | 'CHECKING' | 'UPLOADING' | 'UPLOADED' | 'WAITING' | 'UNUSABLE';

interface Row {
  readonly status: Status;
  readonly uri?: string;
  readonly item?: EvidenceItem;
  readonly reason?: string;
  readonly detail?: string;
  /** Bumped on every retake, so an abandoned upload loop stops. */
  readonly generation: number;
}

const STATUS_TEXT: Record<Status, string> = {
  NOT_TAKEN: 'Not taken',
  CHECKING: 'Checking photo…',
  UPLOADING: 'Uploading…',
  UPLOADED: 'Uploaded',
  WAITING: 'Waiting for signal',
  UNUSABLE: "Can't be used",
};

const TEXT = {
  noFix: "Couldn't get your location for this photo. Move near a window or outside, then take " +
    'it again.',
  imprecise: "Your location isn't precise enough for this photo. Move near a window or " +
    'outside, then take it again.',
  tooLarge: 'This photo is too large to upload.',
  camera: 'BountyCam needs camera access to take mission photos. Open Settings to allow it.',
  confirm: "Submitting is final. You won't be able to retake photos after this.",
  notSigned: "Your wallet didn't sign. Nothing was submitted.",
  notUploaded: "Some photos didn't finish uploading. Uploading them again…",
  unreachable: "Couldn't reach BountyCam. Check your connection and try again.",
  missing: 'Capture time has ended and some required photos are missing. Start again to ' +
    'capture a new set.',
} as const;

function tooFar(distanceM: number): string {
  return 'This photo was taken about ' + String(Math.round(distanceM)) + ' m from the mission ' +
    'spot. Move closer, then take it again.';
}

function clock(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function EvidenceSection(props: {
  readonly token: string;
  readonly provider: WalletProvider;
  readonly view: unknown;
  readonly scoutWallet: string;
  readonly nonce: CaptureNonce | null;
  readonly maxAccuracyM: number;
  readonly maxAgeS: number;
  readonly target: { readonly lat: string; readonly lon: string };
  readonly radiusM: number;
  readonly serverNow: () => number;
  readonly onReload: () => Promise<void>;
}): ReactNode {
  const requirements = readRequirements(props.view);
  // The last session seen. A view reloaded after expires_at carries no nonce, but uploads and
  // the submission stay open until submit_by, so the session is kept until another replaces it.
  const [session, setSession] = useState<CaptureNonce | null>(null);
  const sessionRef = useRef<CaptureNonce | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const rowsRef = useRef<Record<string, Row>>({});
  const [active, setActive] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; detail?: string } | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView | null>(null);
  const latestFix = useRef<Fix | undefined>(undefined);
  const signed = useRef(new Map<string, string>());
  const [, setTick] = useState(0);

  const setRow = useCallback((id: string, row: Row) => {
    rowsRef.current = { ...rowsRef.current, [id]: row };
    setRows(rowsRef.current);
  }, []);

  // Section 7.6: a different session id discards the previous session's photos (D134).
  const incoming = props.nonce;
  useEffect(() => {
    if (incoming === null || incoming.id === sessionRef.current?.id) return;
    for (const row of Object.values(rowsRef.current)) {
      if (row.uri !== undefined) deletePhoto(row.uri);
    }
    rowsRef.current = {};
    setRows({});
    setActive(undefined);
    setMessage(undefined);
    signed.current.clear();
    sessionRef.current = incoming;
    setSession(incoming);
  }, [incoming]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const now = props.serverNow();
  const live = session !== null && now < session.expiresAt;

  // Section 7.2: one high-accuracy update a second while the checklist is live.
  useEffect(() => {
    if (!live) return;
    let sub: Location.LocationSubscription | undefined;
    let cancelled = false;
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
      (p) => {
        latestFix.current = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracyM: p.coords.accuracy,
          timestamp: p.timestamp,
        };
      },
    ).then((s) => {
      if (cancelled) s.remove();
      else sub = s;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [live]);

  // Section 7.4: steps 1 to 3 with retries, until submit_by.
  const upload = useCallback(async (id: string, generation: number) => {
    const s = sessionRef.current;
    if (s === null) return;
    for (let attempt = 0; ; attempt++) {
      const row = rowsRef.current[id];
      if (row === undefined || row.generation !== generation || row.item === undefined ||
        row.uri === undefined || sessionRef.current?.id !== s.id) return;
      if (props.serverNow() >= s.submitBy) return;
      setRow(id, { ...row, status: attempt === 0 ? 'UPLOADING' : row.status });
      const bountyId = readHeaderParts(props.view, props.scoutWallet).bountyId;
      const outcome = await uploadOnce(props.token, bountyId, s.id, {
        requirementId: id,
        sha256Hex: row.item.photo_sha256,
        byteLength: row.item.byte_length,
      }, row.uri);
      const now2 = rowsRef.current[id];
      if (now2 === undefined || now2.generation !== generation) return;
      if (outcome === 'UPLOADED') {
        setRow(id, { ...now2, status: 'UPLOADED' });
        return;
      }
      if (outcome === 'TOO_LARGE') {
        setRow(id, { ...now2, status: 'UNUSABLE', reason: TEXT.tooLarge });
        return;
      }
      if (outcome === 'RELOAD') {
        await props.onReload();
        return;
      }
      setRow(id, { ...now2, status: 'WAITING' });
      await sleep(retryDelayMs(attempt));
    }
  }, [props, setRow]);

  // Section 7.3: at the shutter, in order.
  const onShutter = useCallback(async () => {
    const id = active;
    const s = sessionRef.current;
    if (id === undefined || s === null || camera.current === null) return;
    // Step 1.
    if (props.serverNow() >= s.expiresAt) {
      setActive(undefined);
      return;
    }
    // Step 2.
    const shotAt = props.serverNow();
    const picture = await camera.current.takePictureAsync({ quality: 0.8, exif: false });
    setActive(undefined);
    const previous = rowsRef.current[id];
    const generation = (previous?.generation ?? 0) + 1;
    const refuse = (reason: string, detail?: string) => {
      deletePhoto(picture.uri);
      setRow(id, { status: 'UNUSABLE', reason, ...(detail === undefined ? {} : { detail }),
        generation });
    };
    // Step 3.
    const fix = latestFix.current;
    const ageS = fix === undefined ? undefined : (Date.now() - fix.timestamp) / 1000;
    if (fix === undefined || fix.accuracyM === null || !Number.isFinite(fix.accuracyM) ||
      ageS === undefined || ageS > props.maxAgeS) {
      refuse(TEXT.noFix, judgedLine(fix?.accuracyM ?? undefined, undefined, ageS));
      return;
    }
    // Step 4.
    const located = { ...fix, accuracyM: fix.accuracyM };
    const gate = checkCaptureStart(located, props.target, props.radiusM, props.maxAccuracyM);
    const detail = judgedLine(located.accuracyM, gate.distanceM, ageS);
    if (gate.decision === 'IMPRECISE') {
      refuse(TEXT.imprecise, detail);
      return;
    }
    if (gate.decision === 'TOO_FAR') {
      refuse(tooFar(gate.distanceM), detail);
      return;
    }
    // The retake replaces the previous photo (section 7.3).
    if (previous?.uri !== undefined) deletePhoto(previous.uri);
    setRow(id, { status: 'CHECKING', uri: picture.uri, generation });
    // Steps 5 to 7.
    const record = shutterRecord(id, shotAt, located);
    const hashed = await hashPhoto(picture.uri);
    console.log('evidence photo ' + id.slice(0, 8) + ': ' + String(hashed.byteLength) +
      ' bytes, hashed in ' + String(hashed.hashMs) + ' ms');
    const current = rowsRef.current[id];
    if (current === undefined || current.generation !== generation) return;
    const item: EvidenceItem = {
      ...record,
      byte_length: hashed.byteLength,
      photo_sha256: hashed.sha256Hex,
    };
    setRow(id, { status: 'UPLOADING', uri: picture.uri, item, generation });
    // Step 8.
    void upload(id, generation);
  }, [active, props, setRow, upload]);

  const send = useCallback(async () => {
    const s = sessionRef.current;
    if (s === null) return;
    setConfirming(false);
    setSubmitting(true);
    setMessage(undefined);
    try {
      const items = requirements
        .map((r) => rowsRef.current[r.id]?.item)
        .filter((i): i is EvidenceItem => i !== undefined);
      const manifest = buildManifest(readHeaderParts(props.view, props.scoutWallet), s.value,
        items);
      const outcome = await submitEvidence(props.provider, props.token, manifest, signed.current);
      switch (outcome.kind) {
        case 'SUBMITTED':
        case 'RELOAD':
        case 'EXPIRED':
          await props.onReload();
          return;
        case 'NOT_SIGNED':
          setMessage({ text: TEXT.notSigned, detail: outcome.detail });
          return;
        case 'NOT_UPLOADED':
          setMessage({ text: TEXT.notUploaded });
          for (const r of requirements) {
            const row = rowsRef.current[r.id];
            if (row?.item !== undefined) {
              const generation = row.generation + 1;
              setRow(r.id, { ...row, status: 'UPLOADING', generation });
              void upload(r.id, generation);
            }
          }
          return;
        case 'REFUSED':
          setMessage({ text: "BountyCam couldn't accept this submission (" + outcome.code +
            '). Your photos are still here.' });
          return;
        case 'UNREACHABLE':
          await props.onReload().catch(() => undefined);
          setMessage({ text: TEXT.unreachable });
          return;
      }
    } finally {
      setSubmitting(false);
    }
  }, [props, requirements, setRow, upload]);

  if (session === null) return null;

  const withPhoto = requirements.filter((r) => rows[r.id]?.item !== undefined);
  const requiredDone = requirements.every((r) => !r.required || rows[r.id]?.status === 'UPLOADED');
  const photosDone = withPhoto.every((r) => rows[r.id]?.status === 'UPLOADED');
  const open = now < session.submitBy;
  const canSubmit = requiredDone && photosDone && open && !submitting && withPhoto.length > 0;
  const requiredTaken = requirements.every((r) => !r.required || rows[r.id]?.item !== undefined);

  if (!open) return null;

  if (active !== undefined && live) {
    if (permission?.granted !== true) {
      return (
        <View>
          <Text style={styles.notice}>{TEXT.camera}</Text>
          <View style={styles.buttons}>
            <Button label="Allow camera" onPress={() => void requestPermission()} />
            <Button label="Open Settings" secondary onPress={() => void Linking.openSettings()} />
            <Button label="Cancel" secondary onPress={() => setActive(undefined)} />
          </View>
        </View>
      );
    }
    return (
      <View>
        <Text style={styles.label}>
          {requirements.find((r) => r.id === active)?.prompt ?? ''}
        </Text>
        <CameraView ref={camera} style={{ height: 420, marginBottom: 8 }} facing="back" />
        <View style={styles.buttons}>
          <Button label="Capture" onPress={() => void onShutter()} />
          <Button label="Cancel" secondary onPress={() => setActive(undefined)} />
        </View>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.label}>Photos</Text>
      {!live ? (
        <Text style={styles.notice}>
          {requiredTaken
            ? 'Capture time has ended. Upload and submit before ' + clock(session.submitBy) + '.'
            : TEXT.missing}
        </Text>
      ) : null}
      {requirements.map((r, index) => {
        const row = rows[r.id] ?? { status: 'NOT_TAKEN' as Status, generation: 0 };
        return (
          <View key={r.id} style={styles.row}>
            <Text style={styles.value}>{String(index + 1) + '. ' + r.prompt}</Text>
            <Text style={styles.muted}>
              {(r.required ? 'Required' : 'Optional') + ' · ' + STATUS_TEXT[row.status]}
            </Text>
            {row.reason !== undefined ? <Text style={styles.notice}>{row.reason}</Text> : null}
            {row.detail !== undefined && row.detail !== '' ? (
              <Text style={styles.muted}>{row.detail}</Text>
            ) : null}
            {row.uri !== undefined && row.status !== 'UNUSABLE' ? (
              <Image source={{ uri: row.uri }} style={{ width: 96, height: 128, marginTop: 4 }} />
            ) : null}
            {live ? (
              <View style={styles.chipRow}>
                <Button
                  label={row.status === 'NOT_TAKEN' ? 'Take photo'
                    : row.status === 'UNUSABLE' ? 'Take again' : 'Retake'}
                  disabled={submitting || row.status === 'CHECKING'}
                  onPress={() => {
                    setMessage(undefined);
                    setActive(r.id);
                  }}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {message !== undefined ? <Text style={styles.notice}>{message.text}</Text> : null}
      {message?.detail !== undefined ? <Text style={styles.muted}>{message.detail}</Text> : null}
      {confirming ? (
        <View>
          <Text style={styles.notice}>{TEXT.confirm}</Text>
          <View style={styles.buttons}>
            <Button label="Submit" onPress={() => void send()} />
            <Button label="Cancel" secondary onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : (
        <View style={styles.buttons}>
          <Button
            label={message === undefined ? 'Submit evidence' : 'Try again'}
            disabled={!canSubmit}
            onPress={() => (message === undefined ? setConfirming(true) : void send())}
          />
        </View>
      )}
    </View>
  );
}
