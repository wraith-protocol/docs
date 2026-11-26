use super::*;
use serde_json::Value;
use stellar_strkey::ed25519::PrivateKey;
use stellar_xdr::{ContractId, Hash, WriteXdr};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../python-quickstart/vectors.json")).unwrap()
}

fn owner(data: &Value) -> Recipient {
    // This public, deterministic seed is only for the SDK's offline test vectors.
    let seed: PrivateKey = data["owner"]["secret"].as_str().unwrap().parse().unwrap();
    Recipient::derive(&SigningKey::from_bytes(&seed.0))
}

#[test]
fn sender_matches_sdk_addresses_and_view_tags() -> Result<()> {
    let data = vectors();
    let (spending, viewing) = owner(&data).public_keys();
    for payment in data["stealthAddresses"].as_array().unwrap() {
        let seed = hex::decode(payment["ephemeralSeed"].as_str().unwrap())?
            .try_into()
            .unwrap();
        let announcement = generate_with_key(&spending, &viewing, &SigningKey::from_bytes(&seed))?;
        assert_eq!(announcement.address.to_string(), payment["stealthAddress"]);
        assert_eq!(
            hex::encode(announcement.ephemeral.as_bytes()),
            payment["ephemeralPubKey"]
        );
        assert_eq!(u64::from(announcement.tag), payment["viewTag"]);
    }
    Ok(())
}

#[test]
fn scanner_matches_only_the_owners_recorded_events() -> Result<()> {
    let data = vectors();
    let recipient = owner(&data);
    let mut matches = Vec::new();
    for (index, event) in data["rpc"]["events"].as_array().unwrap().iter().enumerate() {
        let announcement = Announcement::from_event_value(event["value"].as_str().unwrap())?;
        if recipient.matches(&announcement)? {
            matches.push(index);
        }
    }
    assert_eq!(matches, [0, 2]); // Includes a decoy with a matching tag but a different address.
    assert!(Announcement::from_event_value("invalid XDR").is_err());
    Ok(())
}

#[test]
fn builds_the_seven_sender_arguments_in_contract_order() -> Result<()> {
    let data = vectors();
    let announcement =
        Announcement::from_event_value(data["rpc"]["events"][0]["value"].as_str().unwrap())?;
    let contract = ScAddress::Contract(ContractId(Hash([1; 32])));
    let token = ScAddress::Contract(ContractId(Hash([2; 32])));
    let caller: ScAddress = data["owner"]["publicKey"].as_str().unwrap().parse()?;
    let call = announcement.send_call(contract.clone(), caller.clone(), token.clone(), 100)?;
    assert_eq!(
        InvokeContractArgs::from_xdr(call.to_xdr(Limits::none())?, Limits::none())?,
        call
    );
    assert_eq!(call.contract_address, contract);
    assert_eq!(call.function_name.to_string(), "send");
    assert_eq!(
        call.args.as_slice(),
        &[
            ScVal::Address(caller.clone()),
            ScVal::Address(token.clone()),
            ScVal::Address(announcement.address.to_string().parse()?),
            ScVal::from(100_i128),
            ScVal::U32(2),
            ScVal::Bytes(announcement.ephemeral.to_bytes().to_vec().try_into()?),
            ScVal::Bytes(vec![announcement.tag].try_into()?),
        ]
    );
    assert!(announcement.send_call(contract, caller, token, 0).is_err());
    Ok(())
}
