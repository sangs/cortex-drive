// Using native fetch (Node 18+)

async function testQuery(question, history = []) {
    console.log(`\nQuerying: "${question}"`);
    if (history.length > 0) console.log(`History length: ${history.length}`);

    const response = await fetch('http://localhost:3000/query', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'cortex_trial_key_2024'
        },
        body: JSON.stringify({ question, history })
    });

    const data = await response.json();
    if (response.ok) {
        console.log("Answer:", data.answer);
        if (data.raw_data) console.log("Raw Data retrieved.");
        return data;
    } else {
        console.error("Error:", data.error);
        return null;
    }
}

async function runVerification() {
    console.log("--- Starting Enhancements Verification ---");

    // Test 1: Relationship Query (Participants)
    const q1 = "Who is the host and guest of the in-memory graph database discussion (KuzuDB)?";
    const res1 = await testQuery(q1);

    // Test 2: Threading (Follow up)
    if (res1) {
        const history = [
            { role: 'user', content: q1 },
            { role: 'assistant', content: res1.answer }
        ];
        const q2 = "What did they discuss about low overhead?";
        await testQuery(q2, history);
    }

    console.log("\n--- Verification Complete ---");
}

runVerification().catch(console.error);
