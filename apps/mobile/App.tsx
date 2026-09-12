import { Buffer } from 'buffer';
import { useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { transact, Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

const APP_IDENTITY = { name: 'MWA Spike' };
const CHAIN = 'solana:devnet';
const RPC = 'https://api.devnet.solana.com';
const MESSAGE_TEXT = 'BountyCam MWA spike 2026-09-12';

export default function App() {
  const [lines, setLines] = useState<string[]>([]);
  const authRef = useRef<{ address: string; authToken: string } | null>(null);

  const log = (s: string) => {
    console.log('[SPIKE]', s);
    setLines((prev) => [...prev, s]);
  };

  const logError = (label: string, e: unknown) => {
    const err = e as { name?: string; message?: string; code?: unknown };
    log(`${label} FAIL name=${String(err?.name)} code=${String(err?.code)}`);
    log(`${label} message=${String(err?.message)}`);
    log(`${label} raw=${String(e)}`);
  };

  const q1Authorize = async () => {
    try {
      const auth = await transact(async (wallet: Web3MobileWallet) =>
        wallet.authorize({ chain: CHAIN, identity: APP_IDENTITY }),
      );
      const acct = auth.accounts[0];
      if (!acct) return log('Q1 FAIL accounts array is empty');
      const pubkey = new PublicKey(Buffer.from(acct.address, 'base64'));
      authRef.current = { address: acct.address, authToken: auth.auth_token };
      log(`Q1 PASS accounts=${auth.accounts.length}`);
      log(`Q1 address_raw=${acct.address}`);
      log(`Q1 address_base58=${pubkey.toBase58()}`);
      log(`Q1 label=${String(acct.label)} wallet_uri=${String(auth.wallet_uri_base)}`);
    } catch (e) {
      logError('Q1', e);
    }
  };

  const q2SignMessage = async () => {
    try {
      const stored = authRef.current;
      if (!stored) return log('Q2 run Q1 first');
      const message = new Uint8Array(Buffer.from(MESSAGE_TEXT, 'utf8'));
      const signed = await transact(async (wallet: Web3MobileWallet) => {
        await wallet.authorize({
          chain: CHAIN,
          identity: APP_IDENTITY,
          auth_token: stored.authToken,
        });
        return wallet.signMessages({
          addresses: [stored.address],
          payloads: [message],
        });
      });
      const out = signed[0];
      if (!out) return log('Q2 FAIL signMessages returned empty array');
      const pubkey = new PublicKey(Buffer.from(stored.address, 'base64'));
      log(`Q2 PASS result_length=${out.length}`);
      log(`Q2 pubkey_base58=${pubkey.toBase58()}`);
      log(`Q2 message_base64=${Buffer.from(message).toString('base64')}`);
      log(`Q2 result_base64=${Buffer.from(out).toString('base64')}`);
    } catch (e) {
      logError('Q2', e);
    }
  };

  const q3Transfer = async () => {
    try {
      const stored = authRef.current;
      if (!stored) return log('Q3 run Q1 first');
      const pubkey = new PublicKey(Buffer.from(stored.address, 'base64'));
      const connection = new Connection(RPC, 'confirmed');
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      const tx = new Transaction({
        feePayer: pubkey,
        blockhash,
        lastValidBlockHeight,
      }).add(
        SystemProgram.transfer({
          fromPubkey: pubkey,
          toPubkey: pubkey,
          lamports: 1000,
        }),
      );
      const signatures = await transact(async (wallet: Web3MobileWallet) => {
        await wallet.authorize({
          chain: CHAIN,
          identity: APP_IDENTITY,
          auth_token: stored.authToken,
        });
        return wallet.signAndSendTransactions({ transactions: [tx] });
      });
      log(`Q3 SENT signature=${signatures[0]}`);
      log('Q3 confirm on the Mac: solana confirm -v <signature> --url devnet');
    } catch (e) {
      logError('Q3', e);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>MWA spike — throwaway</Text>
      <Button title="Q1 authorize" onPress={q1Authorize} />
      <Button title="Q2 signMessage" onPress={q2SignMessage} />
      <Button title="Q3 signAndSendTransactions" onPress={q3Transfer} />
      <ScrollView style={styles.log}>
        {lines.map((l, i) => (
          <Text key={i} style={styles.line} selectable>
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, paddingHorizontal: 12 },
  title: { fontSize: 16, fontWeight: 'bold', marginBottom: 8 },
  log: { marginTop: 12 },
  line: { fontSize: 11, fontFamily: 'monospace', marginBottom: 4 },
});
