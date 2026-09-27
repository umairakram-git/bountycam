// Session 17: the requester's path (FUNDING.md). A small state machine over
// six screens; no navigation library. The Session 12 sign-in screen is kept as
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

type Screen = 'signin' | 'home' | 'create' | 'review' | 'funding' | 'mine';

interface Session {
  /** A bearer credential. Never logged, never shown. */
  readonly token: string;
  readonly user: SiwsUser;
}

function describeThrown(error: unknown): string {
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
