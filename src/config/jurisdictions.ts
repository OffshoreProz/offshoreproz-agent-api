/**
 * Jurisdiction configuration for the Agent API.
 *
 * This is the authoritative list of available jurisdictions, their pricing,
 * requirements, timelines, and launch phases.
 *
 * Update pricing only after confirming with OffshoreProz operations team.
 * All fees are in USD cents to avoid floating-point issues.
 *
 * Phase legend:
 *  mvp       — Sprint 1-7: available for formation
 *  expansion — Sprint 9+: coming soon
 *  future    — Post-MVP: planned but not scheduled
 */

import type { JurisdictionCode } from "../types.ts";

export type JurisdictionStatus = "available" | "pilot" | "coming_soon";
export type JurisdictionPhase = "mvp" | "expansion" | "future";

export interface RequiredField {
  name: string;
  label: string;
  type:
    | "string"
    | "email"
    | "phone"
    | "address"
    | "date"
    | "url"
    | "boolean"
    | "number";
  required: boolean;
  description: string;
}

export interface JurisdictionPricing {
  /** State/government filing fee (USD cents) */
  government_fee_usd: number;
  /** Registered agent annual fee (USD cents) */
  registered_agent_fee_usd: number;
  /** EIN service fee — null if not applicable (USD cents) */
  ein_fee_usd: number | null;
  /** OffshoreProz service fee (USD cents) — provisional, optional for coming-soon jurisdictions */
  service_fee_usd?: number;
  /** Total charged to client for standard formation (USD cents) */
  total_estimated_usd: number;
  /** Annual maintenance cost (USD cents) */
  annual_maintenance_usd: number;
  /** Pricing note — e.g., "Provisional — subject to change" */
  note?: string;
}

export interface JurisdictionConfig {
  code: JurisdictionCode;
  name: string;
  entity_type: string;
  phase: JurisdictionPhase;
  status: JurisdictionStatus;
  /** Estimated business days to completion */
  eta_days: { min: number; max: number };
  pricing: JurisdictionPricing;
  tax_treatment: string;
  privacy_level: "high" | "medium" | "low";
  /** True if a physical visit/presence is required */
  requires_physical_presence: boolean;
  /** Key differentiators shown to agents */
  key_features: string[];
  /** Best use cases */
  ideal_for: string[];
  /** Fields required in formation request */
  required_fields: RequiredField[];
  /** Legal disclaimer specific to this jurisdiction */
  legal_note: string;
  /**
   * If true, live formations require manual ops review before proceeding to KYC.
   * Admin approves via POST /v1/admin/formations/:id/pilot/approve.
   * Sandbox formations bypass this gate (always simulate automatically).
   */
  requires_pilot_review?: boolean;
}

// ─── Wyoming LLC ──────────────────────────────────────────────────────────────

const WY: JurisdictionConfig = {
  code: "WY",
  name: "Wyoming LLC",
  entity_type: "Limited Liability Company (LLC)",
  phase: "mvp",
  status: "available",
  eta_days: { min: 1, max: 2 },
  pricing: {
    government_fee_usd: 10000, // $100 Wyoming filing fee
    registered_agent_fee_usd: 12500, // $125/year registered agent
    ein_fee_usd: 5000, // $50 EIN service
    service_fee_usd: 22400, // $224 OffshoreProz service fee (provisional)
    total_estimated_usd: 49900, // $499 total — all-in client price (provisional)
    annual_maintenance_usd: 18500, // $185 ($60 annual report + $125 RA)
    note: "Provisional pricing. Breakdown: $100 state fee + $125 RA + $50 EIN + $224 service fee. Subject to change before public launch.",
  },
  tax_treatment:
    "0% Wyoming state income tax. Federal taxes depend on US status of members.",
  privacy_level: "high",
  requires_physical_presence: false,
  key_features: [
    "Zero Wyoming state income tax",
    "No public member registry",
    "100% online filing — same-day submission",
    "EIN (federal tax ID) in 24-48h",
    "Bank account eligible (Mercury, Relay, Wise Business)",
    "Annual report: $60 (due April 1st)",
  ],
  ideal_for: [
    "AI agent operations within the US",
    "Opening US business bank accounts",
    "Contracts with US companies",
    "Builders seeking a low-cost US entity",
    "Fast time-to-operational (48h)",
  ],
  required_fields: [
    {
      name: "company_name",
      label: "Proposed Company Name",
      type: "string",
      required: true,
      description:
        "Must include LLC, L.L.C., or Limited Liability Company. Maximum 80 characters.",
    },
    {
      name: "company_purpose",
      label: "Company Purpose",
      type: "string",
      required: true,
      description: 'e.g., "any lawful business purpose"',
    },
    {
      name: "obtain_ein",
      label: "Obtain EIN",
      type: "boolean",
      required: true,
      description: "Whether to apply for federal EIN with formation",
    },
    {
      name: "beneficial_owner.full_name",
      label: "Owner Full Name",
      type: "string",
      required: true,
      description: "Legal name of the beneficial owner",
    },
    {
      name: "beneficial_owner.email",
      label: "Owner Email",
      type: "email",
      required: true,
      description: "Used for KYC and document delivery",
    },
    {
      name: "beneficial_owner.phone",
      label: "Owner Phone",
      type: "phone",
      required: false,
      description: "International format: +1 555 000 0000",
    },
    {
      name: "beneficial_owner.address",
      label: "Owner Address",
      type: "address",
      required: true,
      description: "Street, city, state/province, country, zip",
    },
    {
      name: "beneficial_owner.id_document_type",
      label: "ID Document Type",
      type: "string",
      required: true,
      description: "passport | drivers_license | national_id",
    },
  ],
  legal_note:
    "Formation of a Wyoming LLC does not constitute legal, tax, or financial advice. Annual Report must be filed by April 1st each year or the company may be administratively dissolved.",
};

// ─── Marshall Islands DAO LLC ─────────────────────────────────────────────────

const MI: JurisdictionConfig = {
  code: "MI",
  name: "Marshall Islands DAO LLC",
  entity_type: "DAO LLC (Decentralized Autonomous Organization)",
  phase: "mvp",
  status: "pilot",
  eta_days: { min: 7, max: 30 },
  pricing: {
    government_fee_usd: 0, // Included in MIDAO package
    registered_agent_fee_usd: 200000, // $2,000/year
    ein_fee_usd: null,
    // MIDAO formation package (filing + Operating Agreement + DAO registration).
    // Without this, estimate_cost would only sum gov+RA ($2,000) and under-quote
    // the advertised $9,500 all-in price. $2,000 RA + $7,500 package = $9,500.
    service_fee_usd: 750000, // $7,500 MIDAO formation package
    total_estimated_usd: 950000, // $9,500 MIDAO standard package
    annual_maintenance_usd: 200000, // $2,000
    note: "Pricing via MIDAO partnership. Final pricing confirmed before formation.",
  },
  tax_treatment:
    "0% for non-resident members. For-profit DAO LLCs may have tax obligations depending on member residency.",
  privacy_level: "high",
  requires_physical_presence: false,
  key_features: [
    "First DAO-specific law in the world (DAO Act 2022)",
    "On-chain governance legally recognized by RMI government",
    "Token holders / wallet addresses can be members",
    "Smart contract address registered as governance mechanism",
    "Zero tax for non-resident members",
    "No requirement for directors, officers, or managers (optional)",
    "Non-profit DAO LLC available",
  ],
  ideal_for: [
    "DAOs with on-chain governance",
    "Web3 and DeFi protocols",
    "AI organizations with on-chain treasury",
    "Projects using multi-sig governance (Gnosis Safe, etc.)",
    "International teams with pseudonymous members",
  ],
  required_fields: [
    {
      name: "company_name",
      label: "DAO Name",
      type: "string",
      required: true,
      description: 'Must include "DAO LLC" in the name',
    },
    {
      name: "governance_model",
      label: "Governance Model",
      type: "string",
      required: true,
      description: "on_chain | hybrid | traditional",
    },
    {
      name: "smart_contract_address",
      label: "Smart Contract Address",
      type: "string",
      required: false,
      description:
        "Ethereum/EVM smart contract address governing the DAO (if on_chain)",
    },
    {
      name: "blockchain_network",
      label: "Blockchain Network",
      type: "string",
      required: false,
      description: "ethereum | polygon | base | solana | other",
    },
    {
      name: "beneficial_owner.full_name",
      label: "UBO Full Name",
      type: "string",
      required: true,
      description: "At least one human UBO required for KYC/AML compliance",
    },
    {
      name: "beneficial_owner.email",
      label: "UBO Email",
      type: "email",
      required: true,
      description: "Used for KYC, signing, and document delivery",
    },
    {
      name: "beneficial_owner.address",
      label: "UBO Address",
      type: "address",
      required: true,
      description: "Full residential address",
    },
    {
      name: "beneficial_owner.ownership_percentage",
      label: "UBO Governance %",
      type: "number",
      required: true,
      description:
        "Percentage of governance rights held by this UBO (25%+ triggers KYC)",
    },
  ],
  legal_note:
    "All UBOs with 25%+ governance must pass enhanced KYC/KYB. Marshall Islands DAO LLC status and applicable law are subject to change. OffshoreProz partners with MIDAO for this jurisdiction. Formation timeline varies based on MIDAO workload.",
  requires_pilot_review: true,
};

// ─── Nevis LLC (coming soon) ──────────────────────────────────────────────────

const NV: JurisdictionConfig = {
  code: "NV",
  name: "Nevis LLC",
  entity_type: "Limited Liability Company",
  phase: "expansion",
  status: "coming_soon",
  eta_days: { min: 3, max: 5 },
  pricing: {
    government_fee_usd: 35000,
    registered_agent_fee_usd: 30000,
    ein_fee_usd: null,
    total_estimated_usd: 65000,
    annual_maintenance_usd: 30000,
  },
  tax_treatment: "0% for non-residents. CRS participant since 2018.",
  privacy_level: "high",
  requires_physical_presence: false,
  key_features: [
    "Strongest asset protection laws in the world",
    "1-year statute of limitations to contest asset transfers",
    "No public member registry",
    "0% tax for non-residents",
  ],
  ideal_for: [
    "Asset protection",
    "Holding structures",
    "Long-term wealth preservation",
  ],
  required_fields: [],
  legal_note:
    "Not yet available via API. Contact OffshoreProz for manual formation.",
};

// ─── BVI Business Company (coming soon) ──────────────────────────────────────

const BVI: JurisdictionConfig = {
  code: "BVI",
  name: "British Virgin Islands Business Company",
  entity_type: "Business Company (BC)",
  phase: "expansion",
  status: "coming_soon",
  eta_days: { min: 7, max: 10 },
  pricing: {
    government_fee_usd: 60000,
    registered_agent_fee_usd: 80000,
    ein_fee_usd: null,
    total_estimated_usd: 140000,
    annual_maintenance_usd: 80000,
  },
  tax_treatment: "0% on all income sources.",
  privacy_level: "high",
  requires_physical_presence: false,
  key_features: [
    "Established offshore jurisdiction",
    "International credibility",
    "Flexible structure",
  ],
  ideal_for: [
    "International holdings",
    "Premium offshore structure",
    "European and Asian clients",
  ],
  required_fields: [],
  legal_note:
    "Not yet available via API. Contact OffshoreProz for manual formation.",
};

// ─── Panama (coming soon) ────────────────────────────────────────────────────

const PA: JurisdictionConfig = {
  code: "PA",
  name: "Panama SA / SRL",
  entity_type: "Sociedad Anónima / SRL",
  phase: "expansion",
  status: "coming_soon",
  eta_days: { min: 5, max: 7 },
  pricing: {
    government_fee_usd: 40000,
    registered_agent_fee_usd: 50000,
    ein_fee_usd: null,
    total_estimated_usd: 90000,
    annual_maintenance_usd: 50000,
  },
  tax_treatment: "Territorial — 0% on foreign-source income.",
  privacy_level: "medium",
  requires_physical_presence: false,
  key_features: [
    "Territorial tax system",
    "LATAM business hub",
    "Long-established legal framework",
  ],
  ideal_for: [
    "LATAM operations",
    "Traditional offshore",
    "Import/export businesses",
  ],
  required_fields: [],
  legal_note:
    "Not yet available via API. Contact OffshoreProz for manual formation.",
};

// ─── UAE RAKEZ (future) ───────────────────────────────────────────────────────

const UAE: JurisdictionConfig = {
  code: "UAE",
  name: "UAE Free Zone LLC (RAKEZ)",
  entity_type: "Free Zone LLC",
  phase: "future",
  status: "coming_soon",
  eta_days: { min: 7, max: 14 },
  pricing: {
    government_fee_usd: 150000,
    registered_agent_fee_usd: 0,
    ein_fee_usd: null,
    total_estimated_usd: 150000,
    annual_maintenance_usd: 80000,
    note: "Requires annual license renewal with RAKEZ. Physical presence may be required.",
  },
  tax_treatment: "0% Free Zone corporate tax.",
  privacy_level: "medium",
  requires_physical_presence: true,
  key_features: [
    "0% Free Zone corporate tax",
    "UAE business address",
    "Access to MENA markets",
  ],
  ideal_for: ["MENA market entry", "High-value technology companies"],
  required_fields: [],
  legal_note:
    "Physical visit to UAE may be required. Not yet available via API.",
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const JURISDICTIONS: Record<JurisdictionCode, JurisdictionConfig> = {
  WY,
  MI,
  NV,
  BVI,
  PA,
  UAE,
};

/** Return jurisdictions visible via the API (excludes purely internal configs). */
export function listJurisdictions(
  includeComingSoon = false,
): JurisdictionConfig[] {
  return Object.values(JURISDICTIONS).filter((j) => {
    if (j.status === "available") return true;
    if (j.status === "pilot") return true;
    if (j.status === "coming_soon" && includeComingSoon) return true;
    return false;
  });
}

export function getJurisdiction(code: string): JurisdictionConfig | undefined {
  if (!isValidCode(code)) return undefined;
  return JURISDICTIONS[code as JurisdictionCode];
}

export function isValidCode(code: string): code is JurisdictionCode {
  return code in JURISDICTIONS;
}
