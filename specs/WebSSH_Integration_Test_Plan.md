# WebSSH Integration Test Plan

## 1. Overview
This document outlines the integration testing strategy for the WebSSH application, focusing on the three most critical backend integrations: LDAP Authentication, SSH PTY Allocation, and Xpra Session Management. The goal is to verify that the Node.js backend correctly interfaces with the cluster's existing infrastructure and the containerised Xpra daemon.

## 2. Test Environment Setup

Before executing the test cases, ensure the following environment conditions are met:

*   **Host OS**: Ubuntu 24.04 LTS.
*   **Deployment**: The WebSSH application must be deployed via `setup.sh` and `docker compose up -d`.
*   **LDAP Server**: The cluster's LDAP server must be reachable from the Docker host. If LDAPS is used, the CA certificate must be correctly mounted into the `app` container.
*   **SSH Target**: The Docker host (or specified `SSH_HOST`) must have an SSH daemon running and accepting password authentication for the test user.
*   **Test Accounts**:
    *   One valid LDAP user account (e.g., `testuser`) with a known password.
    *   One invalid LDAP user account (e.g., `baduser`) or an incorrect password.
    *   The local administrator account configured during `setup.sh`.

## 3. Test Cases

### 3.1. LDAP Authentication Integration

This section verifies that the backend correctly binds to the cluster's LDAP server, attempts LDAPS first, falls back to plain LDAP if necessary, and correctly issues JWTs.

| Test ID | Description | Preconditions | Steps | Expected Result |
| :--- | :--- | :--- | :--- | :--- |
| **LDAP-01** | Successful LDAPS Login | Valid LDAP credentials; LDAPS enabled on server; CA cert mounted. | 1. Navigate to `/login`.<br/>2. Enter valid username and password.<br/>3. Click "Sign In". | User is authenticated. JWT is issued with role `user`. Redirected to Session Tree Page. Backend logs indicate successful LDAPS bind. |
| **LDAP-02** | LDAPS Fallback to Plain LDAP | Valid LDAP credentials; LDAPS disabled or blocked (e.g., wrong port); plain LDAP enabled on port 389. | 1. Navigate to `/login`.<br/>2. Enter valid username and password.<br/>3. Click "Sign In". | User is authenticated. JWT is issued. Backend logs indicate LDAPS failure and successful fallback to plain LDAP. |
| **LDAP-03** | Invalid Credentials Rejection | Invalid LDAP password. | 1. Navigate to `/login`.<br/>2. Enter valid username and incorrect password.<br/>3. Click "Sign In". | Authentication fails. UI displays "Invalid credentials". No JWT is issued. |
| **LDAP-04** | Invalid Username Rejection | Non-existent LDAP username. | 1. Navigate to `/login`.<br/>2. Enter non-existent username and any password.<br/>3. Click "Sign In". | Authentication fails. UI displays "Invalid credentials". |
| **LDAP-05** | Admin Login Bypass | Admin credentials configured in `.env`. | 1. Navigate to `/login`.<br/>2. Enter admin username and password.<br/>3. Click "Sign In". | Admin is authenticated without querying LDAP. JWT is issued with role `admin`. |

### 3.2. SSH PTY Allocation Integration

This section verifies that the backend can successfully open an SSH connection to the target host, allocate a pseudo-terminal (PTY), stream bidirectional I/O over WebSockets, and handle terminal resizing.

| Test ID | Description | Preconditions | Steps | Expected Result |
| :--- | :--- | :--- | :--- | :--- |
| **SSH-01** | Terminal Session Creation | Logged in as a valid LDAP user. | 1. On Session Tree Page, click the `+` button next to the username.<br/>2. Enter password in the prompt and submit. | A new browser tab opens. The `xterm.js` interface displays the shell prompt of the SSH target host. The session node appears in the tree. |
| **SSH-02** | Bidirectional I/O | Terminal session open (SSH-01). | 1. Type `echo "Hello WebSSH"` and press Enter. | The command echoes back in the terminal, and the output "Hello WebSSH" is displayed on the next line. |
| **SSH-03** | Virtual Keyboard Modifier Keys | Terminal session open. | 1. Open a text editor (e.g., `nano`).<br/>2. Type some text.<br/>3. Use the virtual keyboard to tap `Ctrl`, then `X`. | The editor intercepts the `Ctrl+X` sequence and prompts to exit. |
| **SSH-04** | PTY Resizing | Terminal session open. | 1. Resize the browser window significantly.<br/>2. Run `tput cols` and `tput lines`. | The terminal output adjusts cleanly without line wrapping artifacts. The output of the `tput` commands matches the new physical dimensions of the `xterm.js` container. |
| **SSH-05** | Session Persistence | Terminal session open with a running process (e.g., `top`). | 1. Close the terminal browser tab.<br/>2. From the Session Tree Page, click the terminal node to reopen it. | A new tab opens. The `top` process is still running, and the terminal output resumes streaming immediately. |

### 3.3. Xpra Session Management Integration

This section verifies that the backend can dynamically allocate ports, spawn Xpra sessions, proxy the HTML5 client, and handle the parent-child window lifecycle.

| Test ID | Description | Preconditions | Steps | Expected Result |
| :--- | :--- | :--- | :--- | :--- |
| **XPRA-01** | Xpra Session Startup | Terminal session open. | 1. In the terminal, run an X11 application (e.g., `xeyes` or `xterm`). | The backend detects the GUI launch, allocates an Xpra port, and updates the Session Tree with a new child node under the terminal. |
| **XPRA-02** | HTML5 Client Proxying | GUI app launched (XPRA-01). | 1. On the Session Tree Page, click the new GUI child node. | A new tab opens. The Xpra HTML5 client loads, connects via the WebSocket proxy, and displays the graphical application (e.g., the `xeyes` window). |
| **XPRA-03** | Mouse and Keyboard Interaction | GUI tab open (XPRA-02). | 1. Use the physical mouse to click inside the GUI.<br/>2. Use the virtual mouse buttons (L/M/R) to click.<br/>3. Type using the virtual keyboard. | The GUI application responds correctly to both physical and virtual inputs. |
| **XPRA-04** | Cascading Termination | Terminal session open with one or more child GUI apps running. | 1. On the Session Tree Page, click the `⋮` menu for the *parent terminal* node.<br/>2. Select "Close". | The terminal session terminates. The backend automatically terminates all child Xpra sessions. The entire branch disappears from the tree. Open tabs for the terminal and GUI apps display the "Session closed" or disconnect overlay. |
| **XPRA-05** | Admin Observation | User has an active GUI session. Admin is logged in. | 1. Admin navigates to the user's GUI node in the tree.<br/>2. Admin clicks "Observe / Interact". | A new tab opens for the Admin, mirroring the exact state of the user's GUI application in real-time. |

## 4. Troubleshooting and Logs

If any integration tests fail, consult the following logs for diagnostics:

*   **Backend Application Logs**: `docker compose logs -f app` (Check for LDAP bind errors, SSH connection refused, or Redis connection issues).
*   **Nginx Proxy Logs**: `docker compose logs -f nginx` (Check for WebSocket upgrade failures or 502 Bad Gateway errors).
*   **Xpra Container Logs**: `docker compose logs -f xpra` (Check if the Xpra daemon is running and accepting connections).
*   **Host Auth Logs**: `/var/log/auth.log` on the SSH target host (Check for SSH authentication failures).
