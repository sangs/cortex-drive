require('dotenv').config({ path: '../.env' }); // Ensure it reads from root .env

const question = "Show me details of the in-memory graph database discussion";
const gatewayUrl = "http://localhost:3000/query";

async function run() {
    console.log(`Sending query: "${question}"`);
    console.log(`Using API Key: cortex_trial_key_2024`);
    console.log(`Gateway should map this to TENANT_ID: ${process.env.TENANT_ID}`);

    try {
        const response = await fetch(gatewayUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": "cortex_trial_key_2024"
            },
            body: JSON.stringify({ question })
        });

        if (!response.ok) {
            console.error(`Gateway returned status: ${response.status}`);
            console.error(await response.text());
            return;
        }

        const data = await response.json();
        console.log("\n--- ANSWER ---");
        console.log(data.answer);
        
        console.log("\n--- TOOL USED ---");
        console.log(data.tool_used);
        
        console.log("\n--- RAW DATA ---");
        console.log(data.raw_data);
    } catch (err) {
        console.error("Error making request:", err);
    }
}

run().catch(console.error);
