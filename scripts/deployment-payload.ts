import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  encodeDeployData,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { ADDRESSES } from "../shared/chain.ts";
const { values } = parseArgs({
  options: {
    admin: { type: "string" },
    treasury: { type: "string" },
    operator: { type: "string" },
    out: { type: "string", default: "tmp/chancery-deployment.json" },
  },
});
for (const key of ["admin", "treasury", "operator"] as const)
  if (!values[key] || !isAddress(values[key]!))
    throw Error(`--${key} requires a public EVM address.`);
const artifact = JSON.parse(
  await readFile(
    new URL("../contracts/artifacts/ChanceryRegistry.json", import.meta.url),
    "utf8",
  ),
);
const data = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [
    ADDRESSES.usdg,
    values.treasury as Address,
    ADDRESSES.allowanceModule,
    values.admin as Address,
    values.operator as Address,
  ],
});
await writeFile(
  values.out!,
  JSON.stringify(
    {
      chainId: 4663,
      network: "Robinhood Chain mainnet",
      transaction: { data, value: "0x0" },
      constructor: {
        token: ADDRESSES.usdg,
        treasury: values.treasury,
        module: ADDRESSES.allowanceModule,
        administrator: values.admin,
        operator: values.operator,
      },
      creationCodeHash: keccak256(data),
      sourceSha256: artifact.sourceSha256,
      note: "Unsigned deployment. Review and send from your wallet, then configure CHANCERY_REGISTRY_ADDRESS with the confirmed contract address.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(`Unsigned wallet transaction written to ${values.out}`);
