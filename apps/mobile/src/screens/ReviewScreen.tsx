// FUNDING.md 2.2: values from the verified object, never from the form, and
// the SECURITY.md 3 summary line. One button: Fund.
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { formatUsdc, type VerifiedBounty } from '../create/createBounty';
import { Button, Header, TechnicalDetails, shortWallet } from './common';
import { JobRules } from './JobRules';
import { styles } from './styles';

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
      <Header title="Fund your bounty" onBack={props.onBack} />
      <ScrollView>
        {props.resumed ? (
          <Text style={styles.notice}>
            Check the values below: this bounty was created earlier, and the phone no longer
            holds what it sent.
          </Text>
        ) : null}
        <Text style={styles.cardTitle}>{e.title}</Text>
        <Text style={styles.muted}>{e.category}</Text>
        <Text style={styles.rewardLarge}>{amount + ' USDC'}</Text>
        <Text style={styles.meta}>{'Pin: ' + e.policy.lat + ', ' + e.policy.lon}</Text>

        <Text style={styles.section}>
          {'EVIDENCE REQUIRED (' + String(e.policy.evidence_requirements.length) + ')'}
        </Text>
        <View style={styles.card}>
          {e.policy.evidence_requirements.map((r, i) => (
            <Text key={String(i)} style={[styles.value, { marginBottom: 6 }]}>
              {String(i + 1) + '.  ' + r.prompt}
            </Text>
          ))}
        </View>

        <Text style={styles.section}>JOB RULES</Text>
        <JobRules />

        <Text style={styles.notice}>
          {'Transfers exactly ' +
            amount +
            " USDC into this bounty's escrow. Grants no spending permission."}
        </Text>
        <Text style={styles.muted}>{'Paying from ' + shortWallet(props.wallet)}</Text>
        <View style={styles.buttons}>
          <Button label={'Fund bounty · ' + amount + ' USDC'} onPress={props.onFund} />
        </View>
        <TechnicalDetails lines={['Bounty ID: ' + props.bounty.id]} />
      </ScrollView>
    </View>
  );
}
