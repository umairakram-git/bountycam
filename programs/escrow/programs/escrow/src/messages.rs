//! SPEC section 6 message builders (task 12). Layouts are
//! `packages/shared/MESSAGES.md` sections 3 and 4; every offset, width,
//! signedness and domain tag is that document's. Reconstruct-then-compare
//! (D71): the handlers build the complete expected message from
//! configuration, bounty state and validated arguments and never parse a
//! supplied message.
//!
//! `program_id` is a parameter so test 90 can reproduce the published
//! vectors, whose program id is a fill pattern; every call site passes
//! `crate::ID` (task 18 review item).

use anchor_lang::prelude::*;

/// MESSAGES.md section 3: the ASCII text, exactly 24 bytes.
pub const ATTESTATION_DOMAIN_TAG: [u8; 24] = *b"BOUNTYCAM_ATTESTATION_V1";
/// MESSAGES.md section 4: the ASCII text, exactly 24 bytes.
pub const ELIGIBILITY_DOMAIN_TAG: [u8; 24] = *b"BOUNTYCAM_ELIGIBILITY_V1";
/// `schema_version`. SPEC section 9's constants table gives it as "as
/// published" and states that the program's value equals the vectors'; the
/// published vectors carry 1 at offset 24 of every message.
pub const MESSAGE_SCHEMA_VERSION: u16 = 1;
/// MESSAGES.md section 3: total length 261 bytes.
pub const ATTESTATION_MESSAGE_LEN: usize = 261;
/// MESSAGES.md section 4: total length 212 bytes.
pub const ELIGIBILITY_MESSAGE_LEN: usize = 212;

/// The prefix both layouts share, bytes 0 to 203 (MESSAGES.md section 4);
/// only the domain tag differs. Sources per MESSAGES.md section 5.
pub(crate) struct MessagePrefix<'a> {
    /// config
    pub deployment_id: u8,
    /// const; `crate::ID` at every call site
    pub program_id: &'a Pubkey,
    /// state
    pub bounty_id: &'a [u8; 16],
    /// state
    pub requester: &'a Pubkey,
    /// state; at `accept`, the signer
    pub scout: &'a Pubkey,
    /// state
    pub policy_hash: &'a [u8; 32],
    /// state
    pub eligibility_profile_hash: &'a [u8; 32],
    /// state
    pub required_assurance: u8,
}

/// Cursor over a fixed buffer. Fields are copied in table order, so an
/// offset is never computed by hand; the builders assert the final position
/// equals the schema length.
struct Writer<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl Writer<'_> {
    fn put(&mut self, bytes: &[u8]) {
        let end = self.pos + bytes.len();
        self.buf[self.pos..end].copy_from_slice(bytes);
        self.pos = end;
    }
}

/// Bytes 0 to 203 of either message.
fn write_prefix(w: &mut Writer, domain_tag: &[u8; 24], prefix: &MessagePrefix) {
    w.put(domain_tag); // 0, 24
    w.put(&MESSAGE_SCHEMA_VERSION.to_le_bytes()); // 24, 2
    w.put(&[prefix.deployment_id]); // 26, 1
    w.put(prefix.program_id.as_ref()); // 27, 32
    w.put(prefix.bounty_id); // 59, 16
    w.put(prefix.requester.as_ref()); // 75, 32
    w.put(prefix.scout.as_ref()); // 107, 32
    w.put(prefix.policy_hash); // 139, 32
    w.put(prefix.eligibility_profile_hash); // 171, 32
    w.put(&[prefix.required_assurance]); // 203, 1
}

/// `BOUNTYCAM_ELIGIBILITY_V1`, 212 bytes: the prefix, then `expires_at`
/// (caller).
pub(crate) fn eligibility_message(
    prefix: &MessagePrefix,
    expires_at: i64,
) -> [u8; ELIGIBILITY_MESSAGE_LEN] {
    let mut out = [0u8; ELIGIBILITY_MESSAGE_LEN];
    let mut w = Writer { buf: &mut out, pos: 0 };
    write_prefix(&mut w, &ELIGIBILITY_DOMAIN_TAG, prefix);
    w.put(&expires_at.to_le_bytes()); // 204, 8
    assert_eq!(w.pos, ELIGIBILITY_MESSAGE_LEN);
    out
}

/// `BOUNTYCAM_ATTESTATION_V1`, 261 bytes: the prefix, then `deadline` and
/// `review_window_secs` (state), then `evidence_root`, `achieved_assurance`
/// and `issued_at` (caller).
pub(crate) fn attestation_message(
    prefix: &MessagePrefix,
    deadline: i64,
    review_window_secs: i64,
    evidence_root: &[u8; 32],
    achieved_assurance: u8,
    issued_at: i64,
) -> [u8; ATTESTATION_MESSAGE_LEN] {
    let mut out = [0u8; ATTESTATION_MESSAGE_LEN];
    let mut w = Writer { buf: &mut out, pos: 0 };
    write_prefix(&mut w, &ATTESTATION_DOMAIN_TAG, prefix);
    w.put(&deadline.to_le_bytes()); // 204, 8
    w.put(&review_window_secs.to_le_bytes()); // 212, 8
    w.put(evidence_root); // 220, 32
    w.put(&[achieved_assurance]); // 252, 1
    w.put(&issued_at.to_le_bytes()); // 253, 8
    assert_eq!(w.pos, ATTESTATION_MESSAGE_LEN);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published vectors (D78), read at compile time. A missing file is
    /// a compile failure, never a skip.
    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/shared/vectors/vectors.json"
    ));

    // Fixed inputs of packages/shared/vectors/gen_vectors.py, lines 115 to
    // 121 (fill patterns) and lines 123 to 153 (the two base messages).
    const PROGRAM_ID: [u8; 32] = [0x11; 32]; // line 115
    const BOUNTY_ID: [u8; 16] = [0x22; 16]; // line 116
    const REQUESTER: [u8; 32] = [0x33; 32]; // line 117
    const SCOUT: [u8; 32] = [0x44; 32]; // line 118
    const POLICY_HASH: [u8; 32] = [0x55; 32]; // line 119
    const PROFILE_HASH: [u8; 32] = [0x66; 32]; // line 120
    const EVIDENCE_ROOT: [u8; 32] = [0x77; 32]; // line 121
    const DEPLOYMENT_ID: u8 = 1; // lines 126 and 144
    const ATT_REQUIRED: u8 = 2; // line 133
    const ATT_DEADLINE: i64 = 1_790_000_000; // line 134
    const ATT_REVIEW_WINDOW: i64 = 86_400; // line 135
    const ATT_ACHIEVED: u8 = 3; // line 137
    const ATT_ISSUED_AT: i64 = 1_789_900_000; // line 138
    const ELI_REQUIRED: u8 = 4; // line 151
    const ELI_EXPIRES_AT: i64 = 1_789_903_600; // line 152

    /// One message's inputs. Defaults are the base messages; each vector
    /// overrides what its generator line overrides.
    struct Inputs {
        deployment_id: u8,
        bounty_id: [u8; 16],
        requester: [u8; 32],
        scout: [u8; 32],
        policy_hash: [u8; 32],
        eligibility_profile_hash: [u8; 32],
        required_assurance: u8,
        deadline: i64,
        review_window_secs: i64,
        evidence_root: [u8; 32],
        achieved_assurance: u8,
        issued_at: i64,
        expires_at: i64,
    }

    fn base_att() -> Inputs {
        Inputs {
            deployment_id: DEPLOYMENT_ID,
            bounty_id: BOUNTY_ID,
            requester: REQUESTER,
            scout: SCOUT,
            policy_hash: POLICY_HASH,
            eligibility_profile_hash: PROFILE_HASH,
            required_assurance: ATT_REQUIRED,
            deadline: ATT_DEADLINE,
            review_window_secs: ATT_REVIEW_WINDOW,
            evidence_root: EVIDENCE_ROOT,
            achieved_assurance: ATT_ACHIEVED,
            issued_at: ATT_ISSUED_AT,
            expires_at: 0,
        }
    }

    fn base_eli() -> Inputs {
        Inputs {
            required_assurance: ELI_REQUIRED,
            expires_at: ELI_EXPIRES_AT,
            ..base_att()
        }
    }

    fn hex(s: &str) -> Vec<u8> {
        assert_eq!(s.len() % 2, 0, "odd hex length");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn build(kind: &str, i: &Inputs) -> Vec<u8> {
        let program_id = Pubkey::new_from_array(PROGRAM_ID);
        let requester = Pubkey::new_from_array(i.requester);
        let scout = Pubkey::new_from_array(i.scout);
        let prefix = MessagePrefix {
            deployment_id: i.deployment_id,
            program_id: &program_id,
            bounty_id: &i.bounty_id,
            requester: &requester,
            scout: &scout,
            policy_hash: &i.policy_hash,
            eligibility_profile_hash: &i.eligibility_profile_hash,
            required_assurance: i.required_assurance,
        };
        match kind {
            "ATT" => attestation_message(
                &prefix,
                i.deadline,
                i.review_window_secs,
                &i.evidence_root,
                i.achieved_assurance,
                i.issued_at,
            )
            .to_vec(),
            "ELI" => eligibility_message(&prefix, i.expires_at).to_vec(),
            other => panic!("unknown kind {other}"),
        }
    }

    // SPEC test 90: the builders reproduce all 17 published message vectors
    // byte for byte (D78's vectors, consumed by the program). Each match arm
    // cites the gen_vectors.py line that defines the vector.
    #[test]
    fn t90_builders_reproduce_all_published_message_vectors() {
        let doc: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 17, "MESSAGES.md section 8: 17 message vectors");

        let mut seen = std::collections::BTreeSet::new();
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let (kind, inputs) = match name {
                "ATT-01" => ("ATT", base_att()), // line 187
                "ATT-02" => ("ATT", Inputs { deadline: i64::MAX, ..base_att() }), // 189
                "ATT-03" => ("ATT", Inputs { deadline: i64::MIN, ..base_att() }), // 191
                "ATT-04" => ("ATT", Inputs { review_window_secs: 0, ..base_att() }), // 193
                "ATT-05" => ("ATT", Inputs { review_window_secs: -1, ..base_att() }), // 195
                "ATT-06" => (
                    "ATT",
                    Inputs { required_assurance: 0, achieved_assurance: 0, ..base_att() },
                ), // line 197
                "ATT-07" => (
                    "ATT",
                    Inputs { required_assurance: 4, achieved_assurance: 4, ..base_att() },
                ), // line 200
                "ATT-08" => (
                    "ATT",
                    Inputs { required_assurance: 2, achieved_assurance: 4, ..base_att() },
                ), // line 203
                "ATT-09" => ("ATT", Inputs { deployment_id: 0, ..base_att() }), // 206
                "ATT-10" => ("ATT", Inputs { deployment_id: 255, ..base_att() }), // 208
                "ATT-11" => ("ATT", Inputs { issued_at: 0, ..base_att() }), // 210
                "ATT-12" => (
                    "ATT",
                    Inputs {
                        bounty_id: [0; 16],
                        requester: [0; 32],
                        scout: [0; 32],
                        policy_hash: [0; 32],
                        eligibility_profile_hash: [0; 32],
                        evidence_root: [0; 32],
                        ..base_att()
                    },
                ), // line 212
                "ATT-13" => (
                    "ATT",
                    Inputs {
                        bounty_id: [0xff; 16],
                        requester: [0xff; 32],
                        scout: [0xff; 32],
                        policy_hash: [0xff; 32],
                        eligibility_profile_hash: [0xff; 32],
                        evidence_root: [0xff; 32],
                        ..base_att()
                    },
                ), // line 218
                "ELI-01" => ("ELI", base_eli()), // line 226
                "ELI-02" => ("ELI", Inputs { expires_at: i64::MAX, ..base_eli() }), // 228
                "ELI-03" => ("ELI", Inputs { expires_at: 0, ..base_eli() }), // 230
                "ELI-04" => ("ELI", Inputs { required_assurance: 0, ..base_eli() }), // 232
                other => panic!("unknown vector {other}"),
            };
            let built = build(kind, &inputs);
            let expected = hex(v["message_hex"].as_str().unwrap());
            assert_eq!(built.len() as u64, v["message_len"].as_u64().unwrap(), "{name}");
            assert_eq!(built, expected, "{name}: bytes differ");
            assert!(seen.insert(name.to_string()), "{name} listed twice");
        }
        assert_eq!(seen.len(), 17, "17 distinct vector names");
    }
}
