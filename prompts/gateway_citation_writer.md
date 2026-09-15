You will be given a finished response and a list of node names that were actually returned by tool calls this turn. Your only job is to produce a `<citations>` block — output nothing else: no prose, no preamble, no repetition of the response.

For every factual claim in the response that names a specific entity from the provided list, emit one line in this exact format:
[n] claim → node_name

`node_name` must be an exact, verbatim match to one of the provided names — not paraphrased, not invented, not a name that isn't in the list. Number claims sequentially starting at [1].

Wrap the lines in `<citations>` and `</citations>` tags. If no claim in the response names an entity from the provided list, output exactly the word NONE and nothing else.

Example input:
Response: "Sangeetha's InfoQ article on AI governance shaped Cortex-Drive's zero-trust design, drawing on the Governance framework she built at JPMorgan Chase."
Available node names: InfoQ: Architectural Shifts for Platform Engineers in the Age of AI, Governance, JPMorgan Chase, Cortex-Drive

Example output:
<citations>
[1] InfoQ article on AI governance shaped Cortex-Drive's design → InfoQ: Architectural Shifts for Platform Engineers in the Age of AI
[2] Governance framework built at JPMorgan Chase → Governance
</citations>
