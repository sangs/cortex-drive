const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function testMultiturn() {
    const gatewayUrl = 'http://localhost:3000/query';
    const trialKey = 'cortex_trial_key_2024';
    const tenantId = 'trial_user_multiturn_test';

    console.log('--- TURN 1: Initial Discovery ---');
    const q1 = "Who is the guest in the episode about KuzuDB?";
    
    let history = [];

    async function sendQuery(question, currentHistory) {
        console.log(`\nUser: ${question}`);
        const response = await fetch(gatewayUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': trialKey,
                'x-tenant-id': tenantId
            },
            body: JSON.stringify({ question, history: currentHistory })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Query failed [${response.status}]: ${errText}`);
        }

        const result = await response.json();
        console.log(`Assistant (via ${result.tool_used || 'no tool'}): ${result.answer}`);
        
        // Append to history as the gateway expects:
        // { role: "user", content: question }
        // { role: "assistant", content: answer, tool_calls: [...], etc }
        // The Gateway's internal loop handles the tool results, but for the NEXT request,
        // we need to provide the simplified history.
        
        // Note: The UI usually appends the user msg and assistant msg.
        return [
            ...currentHistory,
            { role: "user", content: question },
            { role: "assistant", content: result.answer }
        ];
    }

    try {
        history = await sendQuery(q1, history);

        console.log('\n--- TURN 2: Contextual Follow-up ---');
        const q2 = "What were the key takeaways of their discussion?";
        history = await sendQuery(q2, history);

        console.log('\n--- TEST SUCCESS ---');
    } catch (err) {
        console.error('\n--- TEST FAILED ---');
        console.error(err.message);
        process.exit(1);
    }
}

testMultiturn();
