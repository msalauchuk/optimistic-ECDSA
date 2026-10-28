const { ethers } = require("hardhat");
const fs = require("fs");

/**
 * Script di Benchmark per confrontare:
 * - Verifica on-chain tradizionale vs Approccio ottimistico
 * - Misurazioni di gas, latenza e throughput
 */

// Contratto per verifica on-chain tradizionale (per confronto)
const TRADITIONAL_CONTRACT = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TraditionalSignatureVerifier {
    event SignatureVerified(bytes32 msgHash, address signer);
    
    function verifySignature(
        bytes32 msgHash,
        bytes memory signature,
        address expectedSigner
    ) external returns (bool) {
        address recovered = recoverSigner(msgHash, signature);
        require(recovered == expectedSigner, "Invalid signature");
        emit SignatureVerified(msgHash, recovered);
        return true;
    }
    
    function recoverSigner(
        bytes32 msgHash,
        bytes memory signature
    ) public pure returns (address) {
        require(signature.length == 65, "Invalid signature length");
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        
        return ecrecover(msgHash, v, r, s);
    }
}
`;

async function deployTraditionalContract() {
    // Salva il contratto temporaneo
    fs.writeFileSync(
        "./contracts/TraditionalSignatureVerifier.sol",
        TRADITIONAL_CONTRACT
    );

    // Compila
    await hre.run("compile");

    // Deploy
    const TraditionalVerifier = await ethers.getContractFactory(
        "TraditionalSignatureVerifier"
    );
    const traditional = await TraditionalVerifier.deploy();
    await traditional.waitForDeployment();

    return traditional;
}

async function runBenchmark() {
    console.log("=".repeat(70));
    console.log("BENCHMARK: Optimistic vs Traditional Signature Verification");
    console.log("=".repeat(70));
    console.log();

    // Deploy contracts
    console.log("[SETUP] Deploying contracts...");
    const OptimisticVerifier = await ethers.getContractFactory(
        "OptimisticSignatureVerifier"
    );
    const optimistic = await OptimisticVerifier.deploy();
    await optimistic.waitForDeployment();

    const traditional = await deployTraditionalContract();

    console.log(`        Optimistic: ${await optimistic.getAddress()}`);
    console.log(`        Traditional: ${await traditional.getAddress()}`);
    console.log();

    // Prepare test data
    const [user] = await ethers.getSigners();
    const signer = ethers.Wallet.createRandom();
    const numTests = 10;

    const testCases = [];
    for (let i = 0; i < numTests; i++) {
        const message = `Test transaction #${i}`;
        const msgHash = ethers.hashMessage(message);
        const signature = await signer.signMessage(message);
        testCases.push({ message, msgHash, signature });
    }

    console.log(`[SETUP] Test cases preparati: ${numTests}\n`);

    // ==========================================
    // TEST 1: Gas Cost Comparison
    // ==========================================
    console.log("=".repeat(70));
    console.log("TEST 1: Confronto Costi Gas");
    console.log("=".repeat(70));
    console.log();

    let traditionalTotalGas = 0n;
    let optimisticTotalGas = 0n;

    console.log("[TEST 1] Esecuzione verifica tradizionale (on-chain)...");
    for (let i = 0; i < numTests; i++) {
        const { msgHash, signature } = testCases[i];
        const tx = await traditional.verifySignature(
            msgHash,
            signature,
            signer.address
        );
        const receipt = await tx.wait();
        traditionalTotalGas += receipt.gasUsed;

        if (i === 0) {
            console.log(`         Primo test: ${receipt.gasUsed} gas`);
        }
    }

    console.log(`         Completato: ${traditionalTotalGas} gas totali\n`);

    console.log("[TEST 1] Esecuzione verifica ottimistica (off-chain)...");
    for (let i = 0; i < numTests; i++) {
        const { msgHash, signature } = testCases[i];
        const tx = await optimistic.submitSignature(
            msgHash,
            signature,
            signer.address
        );
        const receipt = await tx.wait();
        optimisticTotalGas += receipt.gasUsed;

        if (i === 0) {
            console.log(`         Primo test: ${receipt.gasUsed} gas`);
        }
    }

    console.log(`         Completato: ${optimisticTotalGas} gas totali\n`);

    // Calcola medie
    const traditionalAvg = traditionalTotalGas / BigInt(numTests);
    const optimisticAvg = optimisticTotalGas / BigInt(numTests);
    const savings = traditionalTotalGas - optimisticTotalGas;
    const savingsPercent = (Number(savings) / Number(traditionalTotalGas)) * 100;

    console.log("RISULTATI GAS:");
    console.log("-".repeat(70));
    console.log(`   Approccio              | Totale Gas  | Media per Tx | Diff vs Traditional`);
    console.log("-".repeat(70));
    console.log(`   Traditional (on-chain) | ${traditionalTotalGas.toString().padStart(11)} | ${traditionalAvg.toString().padStart(12)} | baseline`);
    console.log(`   Optimistic (off-chain) | ${optimisticTotalGas.toString().padStart(11)} | ${optimisticAvg.toString().padStart(12)} | -${savingsPercent.toFixed(1)}%`);
    console.log("-".repeat(70));
    console.log(`   Risparmio totale: ${savings} gas (${savingsPercent.toFixed(1)}%)`);
    console.log();

    // ==========================================
    // TEST 2: Challenge Scenario
    // ==========================================
    console.log("=".repeat(70));
    console.log("TEST 2: Costo Challenge (Caso Fraudolento)");
    console.log("=".repeat(70));
    console.log();

    const fraudCase = testCases[0];
    const fakeAddress = user.address; // Indirizzo sbagliato

    console.log("[TEST 2] Sottomissione firma fraudolenta...");
    const fraudTx = await optimistic.submitSignature(
        fraudCase.msgHash,
        fraudCase.signature,
        fakeAddress
    );
    const fraudReceipt = await fraudTx.wait();

    console.log(`         Gas sottomissione: ${fraudReceipt.gasUsed}`);

    console.log("\n[TEST 2] Esecuzione challenge...");
    const [, challenger] = await ethers.getSigners();
    const challengeTx = await optimistic.connect(challenger)
        .challengeSignature(numTests); // ID della submission fraudolenta
    const challengeReceipt = await challengeTx.wait();

    console.log(`         Gas challenge: ${challengeReceipt.gasUsed}`);

    const totalFraudGas = fraudReceipt.gasUsed + challengeReceipt.gasUsed;

    console.log("\nRISULTATI CHALLENGE:");
    console.log("-".repeat(70));
    console.log(`   Sottomissione fraudolenta:     ${fraudReceipt.gasUsed} gas`);
    console.log(`   Challenge + verifica on-chain: ${challengeReceipt.gasUsed} gas`);
    console.log(`   Totale caso fraudolento:       ${totalFraudGas} gas`);
    console.log(`   Verifica tradizionale:         ${traditionalAvg} gas`);
    console.log("-".repeat(70));
    console.log(`   Overhead frode: ${totalFraudGas - traditionalAvg} gas`);
    console.log(`   (${((Number(totalFraudGas) / Number(traditionalAvg) - 1) * 100).toFixed(1)}% piu costoso)`);
    console.log();

    // ==========================================
    // TEST 3: Throughput Comparison
    // ==========================================
    console.log("=".repeat(70));
    console.log("TEST 3: Stima Throughput");
    console.log("=".repeat(70));
    console.log();

    const BLOCK_GAS_LIMIT = 30_000_000n; // Ethereum block gas limit

    const traditionalTxPerBlock = BLOCK_GAS_LIMIT / traditionalAvg;
    const optimisticTxPerBlock = BLOCK_GAS_LIMIT / optimisticAvg;

    const BLOCK_TIME = 12; // secondi
    const traditionalTps = Number(traditionalTxPerBlock) / BLOCK_TIME;
    const optimisticTps = Number(optimisticTxPerBlock) / BLOCK_TIME;

    console.log("STIMA THROUGHPUT (con limite gas blocco 30M):");
    console.log("-".repeat(70));
    console.log(`   Approccio              | Tx per Blocco | TPS stimato`);
    console.log("-".repeat(70));
    console.log(`   Traditional (on-chain) | ${traditionalTxPerBlock.toString().padStart(13)} | ${traditionalTps.toFixed(2)}`);
    console.log(`   Optimistic (off-chain) | ${optimisticTxPerBlock.toString().padStart(13)} | ${optimisticTps.toFixed(2)}`);
    console.log("-".repeat(70));
    console.log(`   Miglioramento throughput: ${(optimisticTps / traditionalTps).toFixed(2)}x`);
    console.log();

    // ==========================================
    // TEST 4: Latency Analysis
    // ==========================================
    console.log("=".repeat(70));
    console.log("TEST 4: Analisi Latenza");
    console.log("=".repeat(70));
    console.log();

    const CHALLENGE_PERIOD = await optimistic.CHALLENGE_PERIOD();

    console.log("LATENZA DI FINALIZZAZIONE:");
    console.log("-".repeat(70));
    console.log(`   Approccio            | Latenza            | Note`);
    console.log("-".repeat(70));
    console.log(`   Traditional          | 1 blocco (~12s)    | Immediata`);
    console.log(`   Optimistic (test)    | ${CHALLENGE_PERIOD}s (${CHALLENGE_PERIOD / 60n}min)       | Challenge window`);
    console.log(`   Optimistic (prod)    | 604800s (7 giorni) | Security standard`);
    console.log("-".repeat(70));
    console.log(`   Trade-off: Latenza maggiore per gas ridotto`);
    console.log();

    // ==========================================
    // TEST 5: Economic Analysis
    // ==========================================
    console.log("=".repeat(70));
    console.log("TEST 5: Analisi Economica");
    console.log("=".repeat(70));
    console.log();

    const GAS_PRICE_GWEI = 30n; // 30 gwei
    const ETH_PRICE_USD = 3000n;

    const traditionalCostWei = traditionalAvg * GAS_PRICE_GWEI * 1_000_000_000n;
    const optimisticCostWei = optimisticAvg * GAS_PRICE_GWEI * 1_000_000_000n;

    const traditionalCostUSD = (Number(traditionalCostWei) / 1e18) * Number(ETH_PRICE_USD);
    const optimisticCostUSD = (Number(optimisticCostWei) / 1e18) * Number(ETH_PRICE_USD);

    console.log(`COSTO PER TRANSAZIONE (gas: ${GAS_PRICE_GWEI} gwei, ETH: $${ETH_PRICE_USD}):`);
    console.log("-".repeat(70));
    console.log(`   Traditional: $${traditionalCostUSD.toFixed(6)}`);
    console.log(`   Optimistic:  $${optimisticCostUSD.toFixed(6)}`);
    console.log(`   Risparmio:   $${(traditionalCostUSD - optimisticCostUSD).toFixed(6)} per tx`);
    console.log("-".repeat(70));

    const txPerDay = 10000;
    const savingsPerDay = (traditionalCostUSD - optimisticCostUSD) * txPerDay;
    console.log(`   Su ${txPerDay} tx/giorno: $${savingsPerDay.toFixed(2)}/giorno`);
    console.log(`   Su base annua: $${(savingsPerDay * 365).toFixed(2)}/anno`);
    console.log();

    // ==========================================
    // RIEPILOGO FINALE
    // ==========================================
    console.log("=".repeat(70));
    console.log("RIEPILOGO BENCHMARK");
    console.log("=".repeat(70));
    console.log();
    console.log("VANTAGGI Approccio Ottimistico:");
    console.log(`   - Riduzione gas: ${savingsPercent.toFixed(1)}%`);
    console.log(`   - Throughput aumentato: ${(optimisticTps / traditionalTps).toFixed(2)}x`);
    console.log(`   - Risparmio economico: $${(traditionalCostUSD - optimisticCostUSD).toFixed(6)}/tx`);
    console.log();
    console.log("TRADE-OFFS:");
    console.log(`   - Latenza aumentata: da 12s a ${CHALLENGE_PERIOD}s (test) / 7 giorni (prod)`);
    console.log(`   - Costo frode: ${((Number(totalFraudGas) / Number(traditionalAvg) - 1) * 100).toFixed(1)}% piu alto`);
    console.log(`   - Complessita implementativa maggiore`);
    console.log();
    console.log("CONCLUSIONE:");
    console.log("   L'approccio ottimistico e vantaggioso quando:");
    console.log("   - Alta frequenza di transazioni (>1000/giorno)");
    console.log("   - Bassa probabilita di frodi (<1%)");
    console.log("   - Latenza accettabile per il caso d'uso");
    console.log();

    // Salva risultati in file
    const results = {
        timestamp: new Date().toISOString(),
        gasComparison: {
            traditional: {
                total: traditionalTotalGas.toString(),
                average: traditionalAvg.toString()
            },
            optimistic: {
                total: optimisticTotalGas.toString(),
                average: optimisticAvg.toString()
            },
            savings: savings.toString(),
            savingsPercent: savingsPercent
        },
        throughput: {
            traditionalTps,
            optimisticTps,
            improvement: optimisticTps / traditionalTps
        },
        latency: {
            traditional: "12s",
            optimisticTest: `${CHALLENGE_PERIOD}s`,
            optimisticProd: "604800s (7 days)"
        },
        economic: {
            costPerTx: {
                traditional: traditionalCostUSD,
                optimistic: optimisticCostUSD,
                savings: traditionalCostUSD - optimisticCostUSD
            },
            annualSavings: (traditionalCostUSD - optimisticCostUSD) * txPerDay * 365
        }
    };

    fs.writeFileSync(
        "./benchmark-results.json",
        JSON.stringify(results, null, 2)
    );

    console.log("[SAVE] Risultati salvati in: benchmark-results.json\n");
}

async function main() {
    try {
        await runBenchmark();
    } catch (error) {
        console.error("[ERROR] Errore durante benchmark:", error);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });