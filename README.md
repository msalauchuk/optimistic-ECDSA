# Optimistic ECDSA Rollup Prototype

A Hardhat prototype exploring optimistic ECDSA signature verification and batched L2 transactions. Signatures are submitted with a claimed signer and can be challenged on L1 during a short challenge period. A JavaScript sequencer demonstrates collecting transactions, checking signatures off-chain, and proposing batches to an L1 contract.

> **Experimental software:** This repository is a demonstration, not a production-ready rollup or audited security system. The sequencer keeps its state in memory, the challenge period is only five minutes, and the contracts do not implement economic incentives or a complete rollup fraud-proof system. Do not use it to secure real assets.

## What it does

The project contains two Solidity contracts:

- [`OptimisticSignatureVerifier`](contracts/optimistic/OptimisticSignatureVerifier.sol) accepts individual signature submissions, allows challenges when the recovered signer differs from the claimed signer, and supports finalization after the challenge period.
- [`OptimisticRollupL1`](contracts/optimistic/OptimisticRollupl1.sol) adds sequencer-proposed transaction batches and batch finalization to the submission and challenge flow.

The off-chain [`OptimisticSequencer`](sequencer/Sequencer.js) keeps a simple L2 state and mempool in memory, verifies submitted messages, computes a state root, and proposes batches to the L1 contract.

## Why it is useful

- See how optimistic verification defers on-chain signature recovery unless a submission is challenged.
- Explore batching: multiple L2 transactions are represented by a single batch proposal on L1.
- Run local demonstrations and tests with Hardhat without needing a testnet account.
- Compare basic gas measurements for optimistic submissions and traditional on-chain verification.

These are prototype demonstrations; reported gas savings and throughput are estimates from the included scripts, not production benchmarks.

## Get started

### Requirements

- Node.js and npm
- A terminal in the project directory

### Install and compile

```bash
npm install
npx hardhat compile
```

### Run the tests

```bash
npx hardhat test
```

Use `npx hardhat test` directly: the current `package.json` `test` script is a placeholder and exits with an error.

### Run a local demo

Run the end-to-end sequencer and L1 batch demonstration on Hardhat's local network:

```bash
npx hardhat run scripts/demo-l2-complete.js
```

The demo deploys `OptimisticRollupL1`, starts an in-memory sequencer, submits sample signed messages, proposes a batch, and demonstrates challenging a mismatched claimed signer. It runs against a temporary local chain; it does not deploy to a public network.

Other useful scripts:

```bash
# Deploy the individual signature verifier and exercise example scenarios
npx hardhat run scripts/deploy-and-test-base.js

# Compare example gas usage for traditional and optimistic verification
npx hardhat run scripts/benchmark.js
```

The benchmark script writes a temporary `TraditionalSignatureVerifier.sol` into `contracts/` before compiling. Review and remove that generated file after running the benchmark if you do not want to keep it.

### Configure a testnet (optional)

The Hardhat configuration includes Sepolia and Optimism Sepolia. To use them, create a local `.env` file (it is ignored by Git) with the credentials required by [`hardhat.config.js`](hardhat.config.js):

```dotenv
PRIVATE_KEY=your_test_wallet_private_key
INFURA_KEY=your_infura_project_id
```

The `PRIVATE_KEY` must belong to a wallet funded with the target testnet's test ETH. Do not put a real wallet key in the repository or share it. `INFURA_KEY` is used for the Sepolia RPC URL; Optimism Sepolia is configured with its public RPC URL. Gas reporting and explorer verification also recognize optional `COINMARKETCAP_API_KEY`, `ETHERSCAN_API_KEY`, and `OPTIMISM_ETHERSCAN_API_KEY` values.

The configured networks are available to Hardhat commands via `--network sepolia` or `--network optimism_sepolia`. The repository does not include an Ignition deployment module for the optimistic ECDSA contracts; start with the local demos before experimenting with testnet transactions.

## Project layout

| Path | Purpose |
| --- | --- |
| `contracts/optimistic/` | Solidity signature-verification and L1 batch contracts |
| `sequencer/Sequencer.js` | In-memory sequencer, L2 state, and batch proposal logic |
| `scripts/` | Local demonstrations and gas comparison |
| `test/optimistic/` | Hardhat tests for the contracts and sequencer |
| `hardhat.config.js` | Solidity compiler, networks, gas reporter, and explorer settings |

## Help and documentation

- Read the contract, sequencer, and test sources linked above for implementation details.
- Check the [Hardhat documentation](https://hardhat.org/docs) for the development environment.
- Report bugs or ask project-specific questions through the [GitHub issue tracker](https://github.com/msalauchuk/roptimistic-ECDSA/issues).

## Maintainers and contributions

The repository is associated with [msalauchuk/optimistic-ECDSA](https://github.com/msalauchuk/optimistic-ECDSA). For changes, open an issue to discuss substantial work, then submit a pull request with a clear description and tests where appropriate. Run `npx hardhat compile` and `npx hardhat test` before submitting.
