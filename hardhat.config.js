require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
    solidity: {
        version: "0.8.29",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    },
    networks: {
        hardhat: {
            chainId: 1337,
            mining: {
                auto: true,
                interval: 0
            }
        },

        // Sepolia testnet (per test reali)
        sepolia: {
            url: `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`,
            accounts: [process.env.PRIVATE_KEY]
        },

        // Optimism Sepolia (per test su L2)
        optimism_sepolia: {
            url: "https://sepolia.optimism.io",
            accounts: [process.env.PRIVATE_KEY]
        }
    },
    gasReporter: {
        enabled: true,
        currency: "USD",
        outputFile: "gas-report.txt",
        noColors: true,
        coinmarketcap: process.env.COINMARKETCAP_API_KEY || ""
    },
    etherscan: {
        apiKey: {
            sepolia: process.env.ETHERSCAN_API_KEY || "",
            optimismSepolia: process.env.OPTIMISM_ETHERSCAN_API_KEY || ""
        }
    }
};
