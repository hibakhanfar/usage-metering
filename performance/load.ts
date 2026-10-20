import http from "k6/http";
import { check, fail } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import type { Options } from "k6/options";

type Account = {
  id: string;
  apiKey: string;
};

type Plan = {
  id: string;
};

type AccountData = {
  key: string;
  userIds: string[];
};

type SetupData = {
  runId: string;
  accounts: AccountData[];
};

type Decision = {
  accepted: boolean;
  replayed: boolean;
  units: number;
  rejectedBy: "account" | "user" | null;
  rule: string | null;
};

type Usage = {
  account: {
    monthly: {
      used: number;
      remaining: number | null;
    };
    daily: {
      used: number;
    };
  };
  users: {
    total: number;
    items: Array<{
      monthly: { used: number };
      daily: { used: number };
    }>;
  };
};

type History = {
  total: number;
};

type SummaryData = {
  metrics: Record<
    string,
    {
      values: Record<string, number>;
    }
  >;
};

const BASE_URL = __ENV.API_BASE_URL || "http://api:3000";
const TOTAL = Number(__ENV.PERF_REQUESTS || 1000);
const VUS = Number(__ENV.PERF_VUS || 10);
// How many independent accounts share the load. 1 = every request fights for the
// same shared-allowance row (worst case); N = the load is spread over N accounts.
const ACCOUNTS = Number(__ENV.PERF_ACCOUNTS || 1);
const USERS_PER_ACCOUNT = 10;

if (
  !Number.isInteger(TOTAL) ||
  TOTAL < 20 ||
  TOTAL > 100000 ||
  !Number.isInteger(VUS) ||
  VUS < 1 ||
  VUS > 200 ||
  !Number.isInteger(ACCOUNTS) ||
  ACCOUNTS < 1 ||
  ACCOUNTS > 50
) {
  throw new Error("Invalid PERF_REQUESTS, PERF_VUS or PERF_ACCOUNTS");
}

if (TOTAL % ACCOUNTS !== 0 || TOTAL / ACCOUNTS < 20) {
  throw new Error(
    "PERF_REQUESTS must be divisible by PERF_ACCOUNTS, with at least 20 requests per account",
  );
}

const PER_ACCOUNT = TOTAL / ACCOUNTS;
// Per account: half of its requests fit in the allowance, half must be rejected.
const ALLOWANCE = Math.floor(PER_ACCOUNT / 2);
const TOTAL_ACCEPTED = ALLOWANCE * ACCOUNTS;

const acceptedOperations = new Counter("accepted_operations");
const rejectedOperations = new Counter("quota_rejected_operations");

export const options: Options = {
  scenarios: {
    consume: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: TOTAL,
      maxDuration: "5m",
    },
  },
  setupTimeout: "2m",
  teardownTimeout: "1m",
  thresholds: {
    http_req_failed: ["rate==0"],
    checks: ["rate==1"],
    "http_req_duration{endpoint:consume}": ["p(95)<2000"],
    accepted_operations: [`count==${TOTAL_ACCEPTED}`],
    quota_rejected_operations: [`count==${TOTAL - TOTAL_ACCEPTED}`],
  },
};

function call<T>(
  method: string,
  path: string,
  body: unknown,
  key: string,
  admin = false,
): T {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  headers[admin ? "x-admin-token" : "x-api-key"] = key;

  const response = http.request(
    method,
    `${BASE_URL}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers,
      responseType: "text",
      timeout: "60s",
      tags: {
        endpoint: path === "/consume" ? "consume" : "support",
      },
    },
  );

  if (response.status < 200 || response.status >= 300) {
    fail(`${method} ${path} returned HTTP ${response.status}`);
  }

  return response.json() as T;
}

function provisionAccount(
  runId: string,
  index: number,
  adminToken: string,
): AccountData {
  const account = call<Account>(
    "POST",
    "/admin/accounts",
    {
      name: `k6-${runId}-${index}`,
      planName: "Starter",
    },
    adminToken,
    true,
  );

  const key = account.apiKey;

  const accountPlan = call<Plan>(
    "POST",
    "/plans",
    {
      kind: "account",
      name: "LoadAccount",
      monthlyAllowance: ALLOWANCE,
      dailyAllowance: null,
      maxPerRequest: 1,
    },
    key,
  );

  const userPlan = call<Plan>(
    "POST",
    "/plans",
    {
      kind: "user",
      name: "LoadUser",
      monthlyAllowance: null,
      dailyAllowance: null,
      maxPerRequest: 1,
    },
    key,
  );

  call<unknown>("PATCH", "/account/plan", { planId: accountPlan.id }, key);

  const userIds: string[] = [];

  for (let user = 0; user < USERS_PER_ACCOUNT; user++) {
    const externalId = `load-user-${user}`;

    call<unknown>(
      "POST",
      "/users",
      { externalId, planId: userPlan.id },
      key,
    );

    userIds.push(externalId);
  }

  return { key, userIds };
}

export function setup(): SetupData {
  const adminToken = __ENV.ADMIN_TOKEN;

  if (!adminToken) {
    throw new Error("ADMIN_TOKEN is required");
  }

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const accounts: AccountData[] = [];

  for (let index = 0; index < ACCOUNTS; index++) {
    accounts.push(provisionAccount(runId, index, adminToken));
  }

  console.log(
    `Prepared ${TOTAL} operations across ${ACCOUNTS} account(s), ${VUS} VUs, allowance ${ALLOWANCE} per account`,
  );

  return { runId, accounts };
}

export default function (data: SetupData): void {
  const index = exec.scenario.iterationInTest;
  const account = data.accounts[index % data.accounts.length];
  const userId =
    account?.userIds[
      Math.floor(index / data.accounts.length) % USERS_PER_ACCOUNT
    ];

  if (!account || !userId) {
    fail("No account or user available for this iteration");
  }

  const result = call<Decision>(
    "POST",
    "/consume",
    {
      userId,
      units: 1,
      requestId: `${data.runId}-${index}`,
    },
    account.key,
  );

  check(result, {
    "decision is valid": (r) =>
      typeof r.accepted === "boolean" &&
      r.replayed === false &&
      r.units === 1,

    "rejections identify the account monthly limit": (r) =>
      r.accepted === true ||
      (
        r.accepted === false &&
        r.rejectedBy === "account" &&
        r.rule === "monthly_allowance"
      ),
  });

  acceptedOperations.add(result.accepted === true ? 1 : 0);
  rejectedOperations.add(result.accepted === false ? 1 : 0);
}

function verifyAccount(account: AccountData, label: string): boolean {
  const usage = call<Usage>(
    "GET",
    "/usage?limit=100&offset=0",
    undefined,
    account.key,
  );

  const history = call<History>(
    "GET",
    "/requests?limit=1&offset=0",
    undefined,
    account.key,
  );

  const acceptedHistory = call<History>(
    "GET",
    "/requests?limit=1&offset=0&accepted=true",
    undefined,
    account.key,
  );

  const monthlySum = usage.users.items.reduce(
    (sum, user) => sum + user.monthly.used,
    0,
  );

  const dailySum = usage.users.items.reduce(
    (sum, user) => sum + user.daily.used,
    0,
  );

  return check(usage, {
    [`${label}: all ten users are included`]: (u) =>
      u.users.total === USERS_PER_ACCOUNT &&
      u.users.items.length === USERS_PER_ACCOUNT,

    [`${label}: account usage equals allowance`]: (u) =>
      u.account.monthly.used === ALLOWANCE,

    [`${label}: remaining allowance is zero`]: (u) =>
      u.account.monthly.remaining === 0,

    [`${label}: account usage equals sum of user usage`]: (u) =>
      u.account.monthly.used === monthlySum,

    [`${label}: daily totals match monthly totals`]: (u) =>
      u.account.daily.used === ALLOWANCE && dailySum === ALLOWANCE,

    [`${label}: every operation has one history record`]: () =>
      history.total === PER_ACCOUNT,

    [`${label}: accepted history matches consumption`]: () =>
      acceptedHistory.total === ALLOWANCE,
  });
}

export function teardown(data: SetupData): void {
  let correct = true;

  data.accounts.forEach((account, index) => {
    if (!verifyAccount(account, `account ${index}`)) {
      correct = false;
    }
  });

  if (!correct) {
    fail("Final accounting verification failed");
  }

  console.log("PASS: final accounting checks passed");
}

export function handleSummary(data: SummaryData): Record<string, string> {
  // k6 puts setup()'s return value (which contains API keys) into the summary. Drop it.
  const { setup_data: _secrets, ...safeData } = data as SummaryData & {
    setup_data?: unknown;
  };

  const report = {
    generatedAt: new Date().toISOString(),
    workload: {
      requests: TOTAL,
      virtualUsers: VUS,
      accounts: ACCOUNTS,
      registeredUsersPerAccount: USERS_PER_ACCOUNT,
      accountMonthlyAllowance: ALLOWANCE,
      unitsPerOperation: 1,
    },
    summary: safeData,
  };

  const file =
    ACCOUNTS === 1
      ? `/results/summary-c${VUS}.json`
      : `/results/summary-c${VUS}-a${ACCOUNTS}.json`;

  return {
    [file]: JSON.stringify(report, null, 2),

    stdout:
      "\nK6 RESULTS\n" +
      JSON.stringify(
        {
          requests: TOTAL,
          virtualUsers: VUS,
          accounts: ACCOUNTS,
          accepted: data.metrics.accepted_operations?.values.count,
          quotaRejected: data.metrics.quota_rejected_operations?.values.count,
          consumeLatencyMs:
            data.metrics["http_req_duration{endpoint:consume}"]?.values,
          requestsPerSecond: data.metrics.http_reqs?.values.rate,
          checkResults: data.metrics.checks?.values,
        },
        null,
        2,
      ) +
      "\n",
  };
}