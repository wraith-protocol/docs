//! Stellar stealth address creation, v2 event scanning and unsigned contract calls.
use anyhow::{anyhow, ensure, Result};
use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use stellar_strkey::ed25519::PublicKey;
use stellar_xdr::{InvokeContractArgs, Limits, ReadXdr, ScAddress, ScVal};

const MESSAGE: &[u8] = b"Sign this message to generate your Wraith stealth keys.\n\nChain: Stellar\nNote: This signature is used for key derivation only and does not authorize any transaction.";
const SCHEME: u32 = 2;

pub struct Recipient {
    spending: SigningKey,
    viewing: SigningKey,
}

impl Recipient {
    pub fn derive(account: &SigningKey) -> Self {
        let signature = account.sign(MESSAGE).to_bytes();
        let derive = |domain: &[u8]| {
            SigningKey::from_bytes(
                &Sha256::new()
                    .chain_update(domain)
                    .chain_update(signature)
                    .finalize()
                    .into(),
            )
        };
        Self {
            spending: derive(b"wraith:spending:"),
            viewing: derive(b"wraith:viewing:"),
        }
    }

    pub fn public_keys(&self) -> (VerifyingKey, VerifyingKey) {
        (self.spending.verifying_key(), self.viewing.verifying_key())
    }

    pub fn matches(&self, announcement: &Announcement) -> Result<bool> {
        let (spending, viewing) = self.public_keys();
        if view_tag(&announcement.ephemeral, &viewing) != announcement.tag {
            return Ok(false);
        }
        let tweak = shared_tweak(&self.viewing, &announcement.ephemeral)?;
        Ok(address(&spending, tweak)? == announcement.address)
    }
}

pub struct Announcement {
    pub address: PublicKey,
    pub ephemeral: VerifyingKey,
    pub tag: u8,
}

fn view_tag(ephemeral: &VerifyingKey, viewing: &VerifyingKey) -> u8 {
    Sha256::new()
        .chain_update(b"wraith:stellar:view-tag:v2:")
        .chain_update(ephemeral.as_bytes())
        .chain_update(viewing.as_bytes())
        .finalize()[0]
}

fn checked_point(key: &VerifyingKey) -> Result<EdwardsPoint> {
    let point = key.to_edwards();
    ensure!(
        !point.is_small_order() && point.is_torsion_free(),
        "invalid recipient or ephemeral key"
    );
    Ok(point)
}

fn shared_tweak(own: &SigningKey, peer: &VerifyingKey) -> Result<Scalar> {
    let shared = checked_point(peer)?
        .to_montgomery()
        .mul_clamped(own.to_scalar_bytes());
    let digest = Sha256::new()
        .chain_update(b"wraith:scalar:")
        .chain_update(shared.as_bytes())
        .finalize();
    Ok(Scalar::from_bytes_mod_order(digest.into()))
}

fn address(spending: &VerifyingKey, tweak: Scalar) -> Result<PublicKey> {
    let point = checked_point(spending)? + EdwardsPoint::mul_base(&tweak);
    Ok(PublicKey(point.compress().to_bytes()))
}

pub fn generate(spending: &VerifyingKey, viewing: &VerifyingKey) -> Result<Announcement> {
    generate_with_key(spending, viewing, &SigningKey::generate(&mut OsRng))
}

fn generate_with_key(
    spending: &VerifyingKey,
    viewing: &VerifyingKey,
    ephemeral: &SigningKey,
) -> Result<Announcement> {
    Ok(Announcement {
        address: address(spending, shared_tweak(ephemeral, viewing)?)?,
        ephemeral: ephemeral.verifying_key(),
        tag: view_tag(&ephemeral.verifying_key(), viewing),
    })
}

impl Announcement {
    /// Decode the value of a v2 announce event after filtering its contract and topics.
    pub fn from_event_value(value: &str) -> Result<Self> {
        let ScVal::Vec(Some(fields)) = ScVal::from_xdr_base64(
            value,
            Limits {
                depth: 32,
                len: 4096,
            },
        )?
        else {
            anyhow::bail!("expected an announcement tuple");
        };
        let [ScVal::Address(ScAddress::Account(account)), ScVal::Bytes(ephemeral), ScVal::Bytes(metadata)] =
            fields.as_slice()
        else {
            anyhow::bail!("expected account, ephemeral key and metadata");
        };
        Ok(Self {
            address: account.to_string().parse()?,
            ephemeral: VerifyingKey::from_bytes(ephemeral.as_slice().try_into()?)?,
            tag: *metadata.first().ok_or_else(|| anyhow!("empty metadata"))?,
        })
    }

    /// Prepare the seven arguments to stealth-sender.send, without authorizing a transaction.
    pub fn send_call(
        &self,
        contract: ScAddress,
        caller: ScAddress,
        token: ScAddress,
        amount: i128,
    ) -> Result<InvokeContractArgs> {
        ensure!(amount > 0, "amount must be positive");
        ensure!(
            matches!(contract, ScAddress::Contract(_)) && matches!(token, ScAddress::Contract(_)),
            "expected contract IDs"
        );
        Ok(InvokeContractArgs {
            contract_address: contract,
            function_name: "send".try_into().expect("send fits a Soroban symbol"),
            args: vec![
                ScVal::Address(caller),
                ScVal::Address(token),
                ScVal::Address(self.address.to_string().parse()?),
                ScVal::from(amount),
                ScVal::U32(SCHEME),
                ScVal::Bytes(self.ephemeral.to_bytes().to_vec().try_into()?),
                ScVal::Bytes(vec![self.tag].try_into()?),
            ]
            .try_into()?,
        })
    }
}

#[cfg(test)]
mod tests;
