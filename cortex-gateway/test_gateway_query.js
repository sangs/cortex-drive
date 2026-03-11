// Using native global fetch available in Node.js 18+

async function testQuery(question) {
    console.log(`Testing Gateway Query: "${question}"`);
    
    try {
        const response = await fetch('http://localhost:3000/query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'cortex_trial_key_2024' // Using trial key for testing
            },
            body: JSON.stringify({ question })
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('Error:', error);
            return;
        }

        const data = await response.json();
        console.log('\n--- Answer ---');
        console.log(data.answer);
        console.log('\n--- Tool Used ---');
        console.log(data.tool_used || 'None (Direct Answer)');
        console.log('--------------\n');
    } catch (err) {
        console.error('Request failed:', err.message);
    }
}

// Test cases
async function runTests() {
    await testQuery("Who are the guests in episode 1?");
    await testQuery("How many topics are in the database?");
    await testQuery("Tell me about Snowflake.");
}

runTests();
