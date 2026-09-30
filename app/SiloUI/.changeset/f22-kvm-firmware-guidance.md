---
"silo-ui": patch
---

On Linux, the Virtualization check now explains when hardware virtualization is turned off in firmware instead of suggesting a retry, and it now detects when another hypervisor such as VirtualBox or VMware prevents KVM from creating VMs, before the first sandbox fails to start.
