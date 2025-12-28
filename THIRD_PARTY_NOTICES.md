# Third-Party Notices

This project uses the following open-source packages. We are grateful to the maintainers and contributors of these projects.

---

## Production Dependencies

### dockerode
- **License:** Apache-2.0
- **Repository:** https://github.com/apocas/dockerode
- **Description:** Docker Remote API module for Node.js
- **Copyright:** Copyright (c) Pedro Dias

### @kubernetes/client-node
- **License:** Apache-2.0
- **Repository:** https://github.com/kubernetes-client/javascript
- **Description:** Official Kubernetes client library for Node.js
- **Copyright:** Copyright (c) Kubernetes Authors

### express
- **License:** MIT
- **Repository:** https://github.com/expressjs/express
- **Description:** Fast, unopinionated, minimalist web framework
- **Copyright:** Copyright (c) Douglas Christopher Wilson

### js-yaml
- **License:** MIT
- **Repository:** https://github.com/nodeca/js-yaml
- **Description:** YAML 1.2 parser and serializer
- **Copyright:** Copyright (c) Vitaly Puzrin

### winston
- **License:** MIT
- **Repository:** https://github.com/winstonjs/winston
- **Description:** A logger for just about everything
- **Copyright:** Copyright (c) Charlie Robbins

### pidusage
- **License:** MIT
- **Repository:** https://github.com/soyuka/pidusage
- **Description:** Cross-platform process cpu % and memory usage of a PID
- **Copyright:** Copyright (c) Soyuka

---

## Development Dependencies

### jest
- **License:** MIT
- **Repository:** https://github.com/jestjs/jest
- **Description:** Delightful JavaScript Testing Framework
- **Copyright:** Copyright (c) Meta Platforms, Inc. and affiliates.

---

## License Compatibility

All third-party dependencies are compatible with the MIT License used by this project:

| License | Compatible with MIT | Notes |
|---------|---------------------|-------|
| MIT | ✅ Yes | Fully compatible |
| Apache-2.0 | ✅ Yes | Fully compatible, adds patent protection |
| ISC | ✅ Yes | Functionally equivalent to MIT |
| BSD-2-Clause | ✅ Yes | Similar permissive license |
| BSD-3-Clause | ✅ Yes | Similar permissive license |

---

## Generating This File

To update this file with current dependencies:

```bash
# Install license checker
npm install -g license-checker

# Generate license report
license-checker --production --json > licenses.json

# Or get a summary
license-checker --production --summary
```

---

## Questions?

If you have questions about licensing or notice any license compatibility issues, please:
1. Check the [LICENSE](LICENSE) file
2. Review this document
3. Open an issue in our [GitHub repository](https://github.com/kloudough/serverless-managers/issues)

---

**Last Updated:** December 2025