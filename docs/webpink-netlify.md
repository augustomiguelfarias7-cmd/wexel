# WebPink Netlify

WebPink Netlify adds JSON-based URL rules to WebPink. See the policy schema in the example below.

```json
{
  "version": 1,
  "allowHosts": ["api.example.com", "*.trusted.example"],
  "denyHosts": ["blocked.example.com"],
  "allowUrls": ["https://api.example.com/v1"],
  "denyUrls": ["https://api.example.com/admin"],
  "allowInternal": false
}
```

Deny rules always win. Host patterns accept exact hostnames or `*.domain.tld` subdomains. URL rules match an HTTP(S) origin and path prefix. A configured allow list makes policy matching restrictive; host restrictions from the application and sandbox are also enforced. A policy configured when creating `NodeExecution` remains a global baseline: an imported sandbox policy can add restrictions, but cannot override global deny rules or broaden global allow rules.

Without a JSON policy, public hostnames are allowed unless native safety checks block them. Local/private IP addresses, localhost, single-label hosts, reserved local suffixes and punycode hostnames are blocked by default. These checks are heuristics, not a real-time domain reputation service, so explicit deny rules or a maintained threat-intelligence list are needed for stronger reputation filtering. They do not resolve hostnames to verify the final network address, so they cannot fully prevent DNS rebinding or a public hostname resolving to an internal address.

Redirect responses are blocked so a permitted destination cannot silently redirect the request to another host. Validate a redirect target and issue a new request explicitly.

To import a file selected by a browser file picker, pass its text to the sandbox client:

```ts
const jsonText = await selectedFile.text();
sandbox.webPink?.importPolicyJson(jsonText);
```

In Node.js, read the JSON file with the host application's filesystem API. You can also configure a shared default using `webPink: { policyJson: JSON.stringify(policy) }` when creating `NodeExecution`. Invalid JSON and unknown fields are rejected. Use `clearImportedPolicy()` to remove a sandbox-specific imported policy.