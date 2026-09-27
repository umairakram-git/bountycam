// FUNDING.md 2.2: values from the verified object, never from the form, and
// the SECURITY.md 3 summary line. One button: Fund.
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { FIXED_LABELS } from '../create/defaults';
import { formatUsdc, type VerifiedBounty } from '../create/createBounty';
import { Button, Field } from './common';
import { styles } from './styles';

function shortWallet(address: string): string {
  return address.slice(0, 4) + '…' + address.slice(-4);
}

export function ReviewScreen(props: {
  readonly bounty: VerifiedBounty;
  readonly wallet: string;
  readonly resumed: boolean;
  readonly onFund: () => void;
  readonly onBack: () => void;
}): ReactNode {
  const e = props.bounty.expectation;
  const amount = formatUsdc(props.bounty.args.rewardAmount);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Review</Text>
      <ScrollView>
        {props.resumed ? (
          <Text style={styles.notice}>
            Check the values below: this bounty was created earlier, and the phone no longer
            holds what it sent.
          </Text>
        ) : null}
        <Field label="Title" value={e.title} />
        <Field label="Category" value={e.category} />
        <Field label="Location" value={e.policy.lat + ', ' + e.policy.lon} />
        <Field label="Reward" value={amount + ' USDC'} />
        <Field label="Photos" value={String(e.policy.evidence_requirements.length)} />
        {e.policy.evidence_requirements.map((r, i) => (
          <Text key={String(i)} style={styles.muted}>
            {String(i + 1) + '. ' + r.prompt}
          </Text>
        ))}
        {FIXED_LABELS.map(([label, value]) => (
          <Field key={label} label={label} value={value} />
        ))}
        <Field label="Paying wallet" value={shortWallet(props.wallet)} />
        <Field label="Bounty id" value={props.bounty.id} />
        <Text style={styles.notice}>
          {'Transfers exactly ' +
            amount +
            " USDC into this bounty's escrow. Grants no spending permission."}
        </Text>
        <View style={styles.buttons}>
          <Button label={'Fund ' + amount + ' USDC'} onPress={props.onFund} />
          <Button label="Back" secondary onPress={props.onBack} />
        </View>
      </ScrollView>
    </View>
  );
}
