// DISCOVERY.md 3.3: the sequence runs when the screen opens; the log shows what
// happened; the outcome decides the message and whether Accept is offered again.
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { AcceptOutcome } from '../scout/accept';
import { Button, TechnicalDetails } from './common';
import { styles } from './styles';

export function describeAccept(outcome: AcceptOutcome): string {
  switch (outcome.kind) {
    case 'ACCEPTED':
      return 'Accepted.';
    case 'PENDING':
      return 'Sent to Solana, but not confirmed yet. Check My missions in a minute. If it is ' +
        "not there, it didn't go through; you can accept again while the bounty is open.";
    case 'NOT_SENT':
    case 'RETRY':
    case 'HOLD_ENDED':
    case 'TAKEN':
    case 'GONE':
      return outcome.message;
  }
}

export function AcceptingScreen(props: {
  readonly lines: readonly string[];
  readonly outcome: AcceptOutcome | undefined;
  readonly notice: string | undefined;
  readonly onAgain: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const running = props.outcome === undefined;
  const kind = props.outcome?.kind;
  const again = kind === 'RETRY' || kind === 'HOLD_ENDED' || kind === 'NOT_SENT';
  const text =
    props.notice ?? (props.outcome === undefined ? undefined : describeAccept(props.outcome));
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{running ? 'Accepting…' : 'Accept'}</Text>
      {text === undefined ? (
        <Text style={styles.muted}>
          {'Approve the transaction in your wallet. After that, confirming with Solana can take up to a minute.'}
        </Text>
      ) : (
        <Text style={styles.notice}>{text}</Text>
      )}
      <TechnicalDetails lines={props.lines} />
      <View style={styles.buttons}>
        {again ? (
          <Button
            label={kind === 'HOLD_ENDED' ? 'Try again' : 'Accept again'}
            onPress={props.onAgain}
          />
        ) : null}
        <Button label="Done" secondary disabled={running} onPress={props.onDone} />
      </View>
    </View>
  );
}
