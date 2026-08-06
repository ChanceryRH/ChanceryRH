import solc from "solc";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const path = "contracts/src/ChanceryRegistry.sol",
  source = await readFile(path, "utf8");
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { [path]: { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        evmVersion: "cancun",
        outputSelection: {
          "*": {
            "*": [
              "abi",
              "evm.bytecode.object",
              "evm.deployedBytecode.object",
              "evm.deployedBytecode.immutableReferences",
            ],
          },
        },
      },
    }),
  ),
);
for (const error of output.errors || [])
  if (error.severity === "error") {
    console.error(error.formattedMessage);
    process.exitCode = 1;
  }
if (process.exitCode) process.exit(process.exitCode);
await mkdir("contracts/artifacts", { recursive: true });
for (const name of [
  "ChanceryRegistry",
  "SettlementDelegate",
  "SettlementLog",
]) {
  const contract = output.contracts[path][name];
  await writeFile(
    `contracts/artifacts/${name}.json`,
    JSON.stringify(
      {
        contractName: name,
        compiler: solc.version(),
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        immutableReferences: contract.evm.deployedBytecode.immutableReferences,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${name}: ${contract.evm.deployedBytecode.object.length / 2} runtime bytes`,
  );
}
