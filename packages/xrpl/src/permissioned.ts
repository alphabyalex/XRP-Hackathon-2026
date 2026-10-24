import type { CredentialCreate, CredentialAccept, PermissionedDomainSet } from "xrpl";
import type { TxResult } from "@moonshift/shared";
import { submitTx } from "./client.js";
import {
  getAccountAddress,
  getAccountWallet,
  loadAccountsJson,
  saveAccountsJson,
} from "./wallets.js";

export const MS_KYC_CREDENTIAL_TYPE = Buffer.from("MS_KYC", "utf8").toString("hex").toUpperCase();

export async function issueCredential(
  issuerName: "SHARE_ISSUER",
  subjectAddress: string,
  credentialType = MS_KYC_CREDENTIAL_TYPE
): Promise<TxResult> {
  const issuerWallet = getAccountWallet(issuerName);
  const tx: CredentialCreate = {
    TransactionType: "CredentialCreate",
    Account: issuerWallet.address,
    Subject: subjectAddress,
    CredentialType: credentialType,
  };
  return submitTx(issuerWallet, tx);
}

export async function acceptCredential(
  subjectName: "ALICE" | "BOB" | "CAROL" | "DEV",
  issuerAddress: string,
  credentialType = MS_KYC_CREDENTIAL_TYPE
): Promise<TxResult> {
  const subjectWallet = getAccountWallet(subjectName);
  const tx: CredentialAccept = {
    TransactionType: "CredentialAccept",
    Account: subjectWallet.address,
    Issuer: issuerAddress,
    CredentialType: credentialType,
  };
  return submitTx(subjectWallet, tx);
}

export async function createPermissionedDomain(
  issuerName: "SHARE_ISSUER",
  credentialType = MS_KYC_CREDENTIAL_TYPE
): Promise<{ txResult: TxResult; domainId: string }> {
  const issuerWallet = getAccountWallet(issuerName);
  const tx: PermissionedDomainSet = {
    TransactionType: "PermissionedDomainSet",
    Account: issuerWallet.address,
    AcceptedCredentials: [
      {
        Credential: {
          Issuer: issuerWallet.address,
          CredentialType: credentialType,
        },
      },
    ],
  };

  const txResult = await submitTx(issuerWallet, tx);
  const meta: any = (txResult as any).meta ?? {};
  let domainId = "";

  if (Array.isArray(meta.AffectedNodes)) {
    const created = meta.AffectedNodes.find(
      (n: any) => n.CreatedNode?.LedgerEntryType === "PermissionedDomain"
    );
    if (created) {
      domainId = created.CreatedNode.LedgerIndex;
    }
  }

  return { txResult, domainId };
}

export async function setupPermissionedShares(): Promise<{ domainId: string }> {
  const shareIssuerWallet = getAccountWallet("SHARE_ISSUER");
  const personas = ["ALICE", "BOB", "CAROL", "DEV"] as const;

  console.log("Setting up Permissioned Shares (Credentials + PermissionedDomain)...");

  for (const persona of personas) {
    const address = getAccountAddress(persona);
    console.log(`Issuing MS_KYC to ${persona} (${address})...`);
    await issueCredential("SHARE_ISSUER", address);
    console.log(`${persona} accepting MS_KYC credential...`);
    await acceptCredential(persona, shareIssuerWallet.address);
  }

  console.log("Creating Permissioned Domain on SHARE_ISSUER...");
  const { domainId } = await createPermissionedDomain("SHARE_ISSUER");
  console.log(`Permissioned Domain created. DomainID: ${domainId}`);

  if (domainId) {
    const accounts = loadAccountsJson();
    (accounts as any).DomainID = domainId;
    saveAccountsJson(accounts);
  }

  return { domainId };
}
