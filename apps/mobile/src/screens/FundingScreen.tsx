// FUNDING.md 2.3: the sequence runs when the screen opens; the log shows what
// happened; the outcome decides the message and whether Fund is offered again.
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { FundOutcome } from '../funding/fund';
import { Button, TechnicalDetails } from './common';
import { styles } from './styles';

export function describeOutcome(outcome: FundOutcome): string {
  switch (outcome.kind) {
    case 'FUNDED':
      return 'Reward secured in escrow. Your bounty is live for Scouts.';
    case 'PENDING':
      return 'Sent to Solana, but not confirmed yet. Check My bounties in a minute. If it is ' +
        "not funded by then, it didn't go through and the reward is still in your wallet.";
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
  /** D167: offered when the wallet lacks devnet SOL or test USDC. */
  readonly onGetTestFunds: () => void;
  readonly testFundsBusy: boolean;
  readonly testFundsNotice: string | undefined;
}): ReactNode {
  const running = props.outcome === undefined;
  const again = props.outcome !== undefined &&
    (props.outcome.kind === 'NOT_FUNDED' || props.outcome.kind === 'NOT_SENT');
  const needsFunds = props.outcome !== undefined && props.outcome.kind === 'NOT_SENT' &&
    props.outcome.needsTestFunds === true;
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{running ? 'Funding…' : 'Funding'}</Text>
      {props.outcome === undefined ? (
        <Text style={styles.muted}>
          {'Approve the transaction in your wallet. After that, confirming with Solana can take up to a minute.'}
        </Text>
      ) : (
        <Text style={styles.notice}>{describeOutcome(props.outcome)}</Text>
      )}
      {needsFunds ? (
        <Text style={styles.muted}>
          {'BountyCam runs on Solana devnet. Get free test USDC and devnet SOL for this wallet, then fund again.'}
        </Text>
      ) : null}
      {props.testFundsNotice === undefined ? null : (
        <Text style={styles.notice}>{props.testFundsNotice}</Text>
      )}
      <TechnicalDetails lines={props.lines} />
      <View style={styles.buttons}>
        {needsFunds ? (
          <Button
            label={props.testFundsBusy ? 'Sending test funds…' : 'Get test USDC and SOL'}
            disabled={props.testFundsBusy}
            onPress={props.onGetTestFunds}
          />
        ) : null}
        {again ? (
          <Button
            label="Fund again"
            secondary={needsFunds}
            disabled={props.testFundsBusy}
            onPress={props.onFundAgain}
          />
        ) : null}
        <Button label="Done" secondary disabled={running} onPress={props.onDone} />
      </View>
    </View>
  );
}
