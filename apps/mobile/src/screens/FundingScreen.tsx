// FUNDING.md 2.3: the sequence runs when the screen opens; the log shows what
// happened; the outcome decides the message and whether Fund is offered again.
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { FundOutcome } from '../funding/fund';
import { Button, LogPane } from './common';
import { styles } from './styles';

export function describeOutcome(outcome: FundOutcome): string {
  switch (outcome.kind) {
    case 'FUNDED':
      return 'Funded — live for Scouts.';
    case 'PENDING':
      return 'Not confirmed yet. It will show in My bounties once it lands.';
    case 'NOT_FUNDED':
    case 'NOT_SENT':
    case 'MISMATCH':
    case 'CANCELLED':
      return outcome.message;
  }
}

export function FundingScreen(props: {
  readonly lines: readonly string[];
  readonly outcome: FundOutcome | undefined;
  readonly onFundAgain: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const running = props.outcome === undefined;
  const again = props.outcome !== undefined &&
    (props.outcome.kind === 'NOT_FUNDED' || props.outcome.kind === 'NOT_SENT');
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{running ? 'Funding…' : 'Funding'}</Text>
      {props.outcome === undefined ? null : (
        <Text style={styles.notice}>{describeOutcome(props.outcome)}</Text>
      )}
      <LogPane lines={props.lines} />
      <View style={styles.buttons}>
        {again ? <Button label="Fund again" onPress={props.onFundAgain} /> : null}
        <Button label="Done" secondary disabled={running} onPress={props.onDone} />
      </View>
    </View>
  );
}
