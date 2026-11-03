# CLI

`agent-retrace inspect <file>` prints a recording as a timeline:

```text
$ npx agent-retrace inspect examples/support-agent/__recordings__/refund-damaged-order.json
refund-damaged-order  (6 steps, format v1)

 1  LLM   POST api.anthropic.com/v1/messages  model=claude-opus-5-5
        > user: My order A1 arrived broken
        < assistant -> tool_call lookup_order({"orderId":"A1"})
        < assistant -> tool_call search_policies({"query":"damaged or broken item refund"})
 2  tool  lookup_order({"orderId":"A1"})
        < {"status":"delivered","deliveredOn":"2026-10-30","id":"A1","item":"Ceramic coffee mug","totalCent...
 3  tool  search_policies({"query":"damaged or broken item refund"})
        < [{"text":"If an item arrives damaged or broken, refund it in full. The customer does not need to ...
 4  LLM   POST api.anthropic.com/v1/messages  model=claude-opus-5-5
        > tool_result(toolu_01LVnzWvUVswpJU6j8qXgsW3): [{"text":"If an item arrives damaged or broken, refu...
        < assistant -> tool_call issue_refund({"orderId":"A1","reason":"Item arrived broken (ceramic coffee...
 5  tool  issue_refund({"orderId":"A1","reason":"Item arrived broken (ceramic coffee mug)"})
        < {"amountCents":1800,"orderId":"A1","reason":"Item arrived broken (ceramic coffee mug)","refundId"...
 6  LLM   POST api.anthropic.com/v1/messages  model=claude-opus-5-5
        > tool_result(toolu_01FLaRYYmM4jEFeZnPuD7Z7m): {"amountCents":1800,"orderId":"A1","reason":"Item ar...
        < assistant: {"action":"refund","reply":"I'm sorry your ceramic coffee mug arrived broken! I've ref...
```

Options: `--color` and `--no-color` (it also honors `NO_COLOR` and `FORCE_COLOR`).

That is the whole CLI: recording, replaying and updating happen through your test runner.
