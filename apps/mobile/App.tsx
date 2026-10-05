// Session 17: the requester's path (FUNDING.md). Session 18 adds the Scout's
// path (DISCOVERY.md). A small state machine over eleven screens; no navigation
// library. The Session 12 sign-in screen is kept as
// the first screen, and its rules stand: the JWT is never logged.

import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { runSiwsSignIn, type SiwsUser } from './src/auth/signIn';
import {
  createAndVerify,
  expectationFromForm,
  loadAndVerify,
  type CreateForm,
  type VerifiedBounty,
} from './src/create/createBounty';
import { uuidV4 } from './src/create/uuid';
import { fundBounty, type FundOutcome } from './src/funding/fund';
import { CreateScreen } from './src/screens/CreateScreen';
import { FundingScreen } from './src/screens/FundingScreen';
import { MyBountiesScreen } from './src/screens/MyBountiesScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { Button, LogPane } from './src/screens/common';
import { styles } from './src/screens/styles';
import { createMwaWalletProvider } from './src/wallet/mwa';
import { SpecError, verifyAssignedPolicy } from '@hackathon/shared';
import { apiGet } from './src/api/client';
import { acceptBounty, type AcceptOutcome } from './src/scout/accept';
import { hexToBytes, type Point, type PublicBounty } from './src/scout/views';
import { AcceptingScreen } from './src/screens/AcceptingScreen';
import { DetailScreen } from './src/screens/DetailScreen';
import { FindScreen } from './src/screens/FindScreen';
import { MissionScreen } from './src/screens/MissionScreen';
import { MyMissionsScreen } from './src/screens/MyMissionsScreen';
import { BountyReviewScreen } from './src/screens/BountyReviewScreen';

type Screen =
  | 'signin'
  | 'home'
  | 'create'
  | 'review'
  | 'funding'
  | 'mine'
  | 'find'
  | 'detail'
  | 'accepting'
  | 'mission'
  | 'missions'
  | 'bounty';

interface Session {
  /** A bearer credential. Never logged, never shown. */
  readonly token: string;
  readonly user: SiwsUser;
}

function describeThrown(error: unknown): string {
  if (error instanceof SpecError) return error.code + ': ' + error.message;
  if (error instanceof Error) return error.name + ': ' + error.message;
  return String(error);
}

export default function App() {
  const provider = useMemo(() => createMwaWalletProvider(), []);
  const [screen, setScreen] = useState<Screen>('signin');
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [bounty, setBounty] = useState<VerifiedBounty | undefined>(undefined);
  const [resumed, setResumed] = useState(false);
  const [outcome, setOutcome] = useState<FundOutcome | undefined>(undefined);
  // One idempotency key per form submission, reused on a retry (POLICY.md 10).
  const idempotencyKey = useRef<string | undefined>(undefined);
  // DISCOVERY.md 3: the Scout's path.
  const [position, setPosition] = useState<Point | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const [scoutBounty, setScoutBounty] = useState<PublicBounty | undefined>(undefined);
  const [acceptOutcome, setAcceptOutcome] = useState<AcceptOutcome | undefined>(undefined);
  const [acceptNotice, setAcceptNotice] = useState<string | undefined>(undefined);
  const [mission, setMission] = useState<
    { readonly view: unknown; readonly lat: string; readonly lon: string } | undefined
  >(undefined);

  const append = useCallback((line: string) => {
    setLines((previous) => [...previous, line]);
  }, []);

  const onSignIn = useCallback(() => {
    setBusy(true);
    provider.disconnect();
    setLines([]);
    append('=== sign-in run ' + new Date().toISOString() + ' ===');
    runSiwsSignIn(provider, append)
      .then((result) => {
        if (result.ok) {
          append(
            'signed in as ' + result.user.wallet_address + '. Token received and not logged.',
          );
          setSession({ token: result.token, user: result.user });
          setScreen('home');
        } else {
          append('RESULT: failed at ' + result.stage + ' — ' + result.message);
        }
      })
      .catch((error: unknown) => {
        append('UNCAUGHT: ' + describeThrown(error));
      })
      .finally(() => setBusy(false));
  }, [append, provider]);

  const onCreate = useCallback(
    (form: CreateForm) => {
      if (session === undefined) return;
      setNotice(undefined);
      let expectation;
      try {
        expectation = expectationFromForm(form);
      } catch (error: unknown) {
        setNotice(describeThrown(error));
        return;
      }
      const key = idempotencyKey.current ?? uuidV4();
      idempotencyKey.current = key;
      setBusy(true);
      createAndVerify(session.token, key, expectation)
        .then((result) => {
          if (result.ok) {
            idempotencyKey.current = undefined;
            setBounty(result.bounty);
            setResumed(false);
            setScreen('review');
          } else {
            const detail = result.detail === undefined ? '' : ' (' + result.detail + ')';
            setNotice(result.message + detail);
          }
        })
        .catch((error: unknown) => setNotice('UNCAUGHT: ' + describeThrown(error)))
        .finally(() => setBusy(false));
    },
    [session],
  );

  const onResume = useCallback(
    (id: string) => {
      if (session === undefined) return;
      setBusy(true);
      loadAndVerify(session.token, id)
        .then((result) => {
          if (result.ok) {
            setBounty(result.bounty);
            setResumed(true);
            setScreen('review');
          } else {
            setLines([result.message, result.detail ?? '']);
            setScreen('home');
          }
        })
        .catch((error: unknown) => {
          setLines(['UNCAUGHT: ' + describeThrown(error)]);
          setScreen('home');
        })
        .finally(() => setBusy(false));
    },
    [session],
  );

  const onFund = useCallback(() => {
    if (session === undefined || bounty === undefined) return;
    setOutcome(undefined);
    setLines(['=== funding ' + bounty.id + ' ' + new Date().toISOString() + ' ===']);
    setScreen('funding');
    setBusy(true);
    fundBounty(provider, session.token, bounty.id, bounty.args, session.user.wallet_address, append)
      .then((result) => {
        append('outcome: ' + result.kind);
        setOutcome(result);
      })
      .catch((error: unknown) => {
        append('UNCAUGHT: ' + describeThrown(error));
        setOutcome({ kind: 'NOT_SENT', message: 'Something went wrong. See the log.' });
      })
      .finally(() => setBusy(false));
  }, [append, bounty, provider, session]);

  // DISCOVERY.md 3.4: nothing is shown unless the policy hashes as expected.
  const showMission = useCallback(
    (view: unknown, expectedHash: Uint8Array): boolean => {
      try {
        const spot = verifyAssignedPolicy(view, expectedHash);
        setMission({ view, lat: spot.lat, lon: spot.lon });
        setScreen('mission');
        return true;
      } catch (error: unknown) {
        append('assigned view check failed: ' + describeThrown(error));
        return false;
      }
    },
    [append],
  );

  const onAccept = useCallback(
    (target: PublicBounty) => {
      if (session === undefined) return;
      setScoutBounty(target);
      setAcceptOutcome(undefined);
      setAcceptNotice(undefined);
      setLines(['=== accepting ' + target.id + ' ' + new Date().toISOString() + ' ===']);
      setScreen('accepting');
      setBusy(true);
      acceptBounty(provider, session.token, target, session.user.wallet_address, append)
        .then((result) => {
          append('outcome: ' + result.kind);
          setAcceptOutcome(result);
          if (result.kind === 'ACCEPTED' && !showMission(result.view, result.policyHash)) {
            setAcceptNotice(
              "This mission's details don't match what was accepted. Contact support.",
            );
          }
        })
        .catch((error: unknown) => {
          append('UNCAUGHT: ' + describeThrown(error));
          setAcceptOutcome({
            kind: 'NOT_SENT',
            message: 'Something went wrong. See the log.',
          });
        })
        .finally(() => setBusy(false));
    },
    [append, provider, session, showMission],
  );

  // DISCOVERY.md 3.5: from My missions the expected hash is the view's own.
  const onOpenMission = useCallback(
    (id: string) => {
      if (session === undefined) return;
      setBusy(true);
      setLines([]);
      apiGet(session.token, '/bounties/' + id)
        .then((result) => {
          const hash = (result.body as { policy_hash?: unknown } | undefined)?.policy_hash;
          if (result.status !== 200) {
            setLines(["Couldn't open this mission (HTTP " + String(result.status) + ').']);
            setScreen('home');
            return;
          }
          const shown =
            typeof hash === 'string' &&
            /^[0-9a-f]{64}$/.test(hash) &&
            showMission(result.body, hexToBytes(hash));
          if (!shown) {
            setLines(["This mission's details don't match what was accepted. Contact support."]);
            setScreen('home');
          }
        })
        .catch((error: unknown) => {
          setLines(['UNCAUGHT: ' + describeThrown(error)]);
          setScreen('home');
        })
        .finally(() => setBusy(false));
    },
    [session, showMission],
  );

  if (screen === 'signin' || session === undefined) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>BountyCam — sign in</Text>
        <View style={styles.buttons}>
          <Button
            label={busy ? 'Signing in…' : 'Sign in with wallet'}
            disabled={busy}
            onPress={onSignIn}
          />
          <Button label="Clear" secondary onPress={() => setLines([])} />
        </View>
        <LogPane lines={lines} />
        <StatusBar style="light" />
      </View>
    );
  }

  if (screen === 'create') {
    return (
      <CreateScreen
        busy={busy}
        notice={notice}
        onSubmit={onCreate}
        onBack={() => setScreen('home')}
      />
    );
  }

  if (screen === 'review' && bounty !== undefined) {
    return (
      <ReviewScreen
        bounty={bounty}
        wallet={session.user.wallet_address}
        resumed={resumed}
        onFund={onFund}
        onBack={() => setScreen('home')}
      />
    );
  }

  if (screen === 'funding') {
    return (
      <FundingScreen
        lines={lines}
        outcome={outcome}
        onFundAgain={onFund}
        onDone={() => setScreen('home')}
      />
    );
  }

  if (screen === 'mine') {
    return (
      <MyBountiesScreen
        token={session.token}
        busy={busy}
        onFund={onResume}
        onOpen={(id) => {
          setDetailId(id);
          setScreen('bounty');
        }}
        onBack={() => setScreen('home')}
      />
    );
  }

  // REVIEW.md section 2: the requester's review, approve and reject.
  if (screen === 'bounty' && detailId !== undefined) {
    return (
      <BountyReviewScreen
        token={session.token}
        id={detailId}
        provider={provider}
        sessionWallet={session.user.wallet_address}
        onBack={() => setScreen('mine')}
      />
    );
  }

  if (screen === 'find') {
    return (
      <FindScreen
        token={session.token}
        onOpen={(id, point) => {
          setDetailId(id);
          setPosition(point);
          setScreen('detail');
        }}
        onBack={() => setScreen('home')}
      />
    );
  }

  if (screen === 'detail' && detailId !== undefined) {
    return (
      <DetailScreen
        token={session.token}
        id={detailId}
        position={position}
        onAccept={onAccept}
        onBack={() => setScreen('find')}
      />
    );
  }

  if (screen === 'accepting') {
    return (
      <AcceptingScreen
        lines={lines}
        outcome={acceptOutcome}
        notice={acceptNotice}
        onAgain={() => {
          if (scoutBounty !== undefined) onAccept(scoutBounty);
        }}
        onDone={() => setScreen('home')}
      />
    );
  }

  if (screen === 'mission' && mission !== undefined) {
    return (
      <MissionScreen
        view={mission.view}
        lat={mission.lat}
        lon={mission.lon}
        token={session?.token ?? ''}
        onBack={() => setScreen('home')}
        onMissions={() => setScreen('missions')}
        provider={provider}
        scoutWallet={session.user.wallet_address}
      />
    );
  }

  if (screen === 'missions') {
    return (
      <MyMissionsScreen
        token={session.token}
        busy={busy}
        onOpen={onOpenMission}
        onBack={() => setScreen('home')}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>BountyCam</Text>
      <Text style={styles.muted}>{'Signed in as ' + session.user.wallet_address}</Text>
      <View style={styles.buttons}>
        <Button
          label="Create a bounty"
          onPress={() => {
            setNotice(undefined);
            setScreen('create');
          }}
        />
        <Button label="My bounties" secondary onPress={() => setScreen('mine')} />
        <Button label="Find bounties" onPress={() => setScreen('find')} />
        <Button label="My missions" secondary onPress={() => setScreen('missions')} />
        <Button
          label="Sign out"
          secondary
          onPress={() => {
            provider.disconnect();
            setSession(undefined);
            setLines([]);
            setScreen('signin');
          }}
        />
      </View>
      <LogPane lines={lines} />
      <StatusBar style="light" />
    </View>
  );
}
