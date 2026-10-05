// GENERADO por scripts/contract-gen.mjs desde backend/app/contract/fixtures.json. NO EDITAR A MANO: `pnpm contract:gen`.
// Literales anotados con los tipos de data/types.ts: si Rust y TypeScript divergen, `tsc -b` falla aquí.
import type { ActionOutcome, ActionPlan, ActionRequest, AffectedKind, ApiError, ApiErrorCode, AppFeed, BuildFeed, BuildOutcome, BuildPlan, BuildStream, BuildWarning, BusySummary, CleanupCategoryId, CleanupEstimate, CleanupReport, CleanupRisk, ComposeFlavor, ComposeInfo, ConnSpec, ConnTestResult, ConnectionCause, ConnectionStatus, Container, ContainerDetail, ContainerState, CreatePlan, CreateResult, CreateWarning, DenyReason, DiagStepId, EndReason, EngineEventKind, EngineFeed, ExecEndReason, ExecFeed, GpuInfo, GroupOp, GroupsImportResult, GroupsSnapshot, HostKeyProbe, HostKeyState, Image, LayerPhase, LogFeed, LogStream, MountKind, Network, PlanDecision, PlanWarning, PodmanCandidate, PortProtocol, ProgressKind, ProgressStatus, PullFeed, PullOutcome, RegistrySummary, Restart, ServicePhase, SshIdentity, SshMode, StackFiles, StackOpFeed, StackOpKind, StackOrigin, StackOutcome, StackRisk, StackStatus, StackSummary, StackValidation, StatsFeed, StatsSnapshotItem, StepStatus, SystemUsage, TrayStatus, ValidationKind, Volume } from '../../types'
import type { RawProfile } from './store'

/** Resultado de cada comando IPC, anotado con su tipo TS (`result_type` de Rust traducido). */
export const result_build_plan: BuildPlan = {
  "decision": {
    "type": "confirm"
  },
  "expires_in_secs": 90,
  "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
  "warnings": [
    {
      "path": "/home/u",
      "type": "sensitive_context"
    }
  ]
}
export const result_busy_summary: BusySummary = {
  "builds": 0,
  "pulls": 0,
  "stacks": 1,
  "terminals": 2
}
export const result_cancel_action: null = null
export const result_cancel_stack_op: null = null
export const result_cleanup_report: CleanupReport = {
  "categories": [
    {
      "executable": true,
      "id": "unused_volumes",
      "items": [
        {
          "estimate": "upper_bound",
          "id": "data",
          "kind": "volume",
          "name": "data",
          "reason": "sin uso",
          "risk": "high",
          "selected_by_default": false,
          "size_bytes": 10
        }
      ],
      "reclaimable_bytes": 10
    },
    {
      "executable": false,
      "id": "build_cache",
      "items": [],
      "reclaimable_bytes": null
    }
  ],
  "defaults_truncated": false,
  "generated_at": "2025-01-02T03:04:05Z",
  "total_reclaimable_bytes": 10,
  "unknown_count": 1
}
export const result_compose_info: ComposeInfo = {
  "available": true,
  "docker_cli": true,
  "flavor": "plugin",
  "supported": true,
  "version": "2.29.7"
}
export const result_connection_delete: null = null
export const result_connection_list: RawProfile[] = [
  {
    "host": "10.0.0.5",
    "host_key_fp": "SHA256:abc",
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3e",
    "identity": {
      "path": "/home/u/.ssh/id_ed25519",
      "type": "file"
    },
    "kind": "ssh",
    "mode": "alias",
    "name": "srv",
    "port": 22,
    "remote": true,
    "simulated": false,
    "user": "deploy"
  }
]
export const result_connection_probe_host_key: HostKeyProbe = {
  "fingerprint_sha256": "SHA256:abc",
  "key_type": "ssh-ed25519",
  "state": "unknown"
}
export const result_connection_save: RawProfile = {
  "host": "10.0.0.5",
  "host_key_fp": "SHA256:abc",
  "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3e",
  "identity": {
    "path": "/home/u/.ssh/id_ed25519",
    "type": "file"
  },
  "kind": "ssh",
  "mode": "alias",
  "name": "srv",
  "port": 22,
  "remote": true,
  "simulated": false,
  "user": "deploy"
}
export const result_connection_select: ConnectionStatus = {
  "endpoint": "unix:///var/run/docker.sock",
  "server": {
    "api_version": "1.47",
    "arch": "amd64",
    "os": "linux",
    "version": "27.3.1"
  },
  "state": "connected"
}
export const result_connection_status: ConnectionStatus = {
  "endpoint": "unix:///var/run/docker.sock",
  "server": {
    "api_version": "1.47",
    "arch": "amd64",
    "os": "linux",
    "version": "27.3.1"
  },
  "state": "connected"
}
export const result_connection_test: ConnTestResult = {
  "cause": "auth_failed",
  "error": {
    "cause": null,
    "code": "conflict",
    "message": "recurso en uso"
  },
  "ok": false,
  "server": null
}
export const result_connection_trust_host_key: HostKeyProbe = {
  "fingerprint_sha256": "SHA256:abc",
  "key_type": "ssh-ed25519",
  "state": "unknown"
}
export const result_container_stats_snapshot: StatsSnapshotItem[] = [
  {
    "error": null,
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "stats": {
      "block_read_bytes": 3,
      "block_write_bytes": 4,
      "cpu_percent": 12.5,
      "mem_limit_bytes": 2097152,
      "mem_percent": 50,
      "mem_used_bytes": 1048576,
      "net_rx_bytes": 10,
      "net_rx_bytes_per_sec": 1.5,
      "net_tx_bytes": 20,
      "net_tx_bytes_per_sec": 2.5,
      "pids": 7,
      "read_at": "2025-01-02T03:04:05Z"
    }
  },
  {
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "id": "b2",
    "stats": null
  }
]
export const result_create_container: CreateResult = {
  "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
  "name": "web",
  "start_error": {
    "cause": null,
    "code": "conflict",
    "message": "recurso en uso"
  },
  "started": false,
  "warnings": [
    "aviso"
  ]
}
export const result_create_network: Network = {
  "compose_project": "shop",
  "connected": [
    "web"
  ],
  "driver": "bridge",
  "id": "n1",
  "internal": false,
  "name": "shop_default",
  "scope": "local",
  "subnets": [
    "172.18.0.0/16"
  ],
  "system": false
}
export const result_create_volume: Volume = {
  "anonymous": false,
  "compose_project": "shop",
  "created_at": "2025-01-02T03:04:05Z",
  "driver": "local",
  "labels": {
    "com.docker.compose.project": "shop"
  },
  "mountpoint": "/var/lib/docker/volumes/data/_data",
  "name": "data",
  "size_bytes": 4096,
  "used_by": [
    "web"
  ]
}
export const result_exec_close: null = null
export const result_exec_resize: null = null
export const result_exec_write: null = null
export const result_execute_action: ActionOutcome = {
  "failed": [
    {
      "error": {
        "cause": null,
        "code": "conflict",
        "message": "recurso en uso"
      },
      "item": {
        "id": "data",
        "kind": "volume",
        "name": "data"
      }
    }
  ],
  "freed_bytes": 4096,
  "succeeded": [
    {
      "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
      "kind": "container",
      "name": "web"
    }
  ]
}
export const result_gpu_status: GpuInfo[] = [
  {
    "index": 0,
    "mem_total_bytes": 8192,
    "mem_used_bytes": 1024,
    "name": "NVIDIA RTX",
    "temperature_c": 60,
    "utilization_percent": 37.5
  },
  {
    "index": 1,
    "mem_total_bytes": 4096,
    "mem_used_bytes": 0,
    "name": "NVIDIA T4",
    "temperature_c": null,
    "utilization_percent": 0
  }
]
export const result_groups_import_legacy: GroupsImportResult = {
  "already_imported": false,
  "dropped_assignments": 0,
  "imported_assignments": 1,
  "imported_groups": 1,
  "snapshot": {
    "assignments": [
      {
        "connection_id": "local",
        "container_name": "web",
        "group_id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40"
      }
    ],
    "groups": [
      {
        "hue": 210,
        "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40",
        "name": "Web"
      }
    ],
    "legacy_imported": true,
    "stack_hues": {
      "shop": 120
    }
  }
}
export const result_groups_load: GroupsSnapshot = {
  "assignments": [
    {
      "connection_id": "local",
      "container_name": "web",
      "group_id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40"
    }
  ],
  "groups": [
    {
      "hue": 210,
      "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40",
      "name": "Web"
    }
  ],
  "legacy_imported": true,
  "stack_hues": {
    "shop": 120
  }
}
export const result_groups_mutate: GroupsSnapshot = {
  "assignments": [
    {
      "connection_id": "local",
      "container_name": "web",
      "group_id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40"
    }
  ],
  "groups": [
    {
      "hue": 210,
      "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b40",
      "name": "Web"
    }
  ],
  "legacy_imported": true,
  "stack_hues": {
    "shop": 120
  }
}
export const result_inspect_container: ContainerDetail = {
  "cpu_limit": 1.5,
  "created_at": "2025-01-02T03:04:05Z",
  "error": null,
  "exit_code": null,
  "finished_at": null,
  "ip_address": "172.18.0.2",
  "memory_limit_bytes": 536870912,
  "networks": [
    {
      "aliases": [],
      "gateway": "172.18.0.1",
      "ip_address": "172.18.0.2",
      "ipv6_address": null,
      "mac_address": null,
      "name": "shop_default"
    }
  ],
  "oom_killed": false,
  "pid": 4242,
  "raw": {
    "Id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "State": {
      "Status": "running"
    }
  },
  "restart_count": 1,
  "restart_policy": "unless-stopped",
  "started_at": "2025-01-02T03:04:06Z",
  "summary": {
    "compose_project": "shop",
    "compose_service": "web",
    "created": 1727300000,
    "endpoints": [
      {
        "aliases": [
          "web"
        ],
        "gateway": "172.18.0.1",
        "ip_address": "172.18.0.2",
        "ipv6_address": null,
        "mac_address": "02:42:ac:12:00:02",
        "name": "shop_default"
      }
    ],
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "image": "nginx:1.27",
    "image_id": "sha256:aa11",
    "mounts": [
      {
        "destination": "/data",
        "kind": "volume",
        "name": "data",
        "read_write": true,
        "source": "/var/lib/docker/volumes/data/_data"
      },
      {
        "destination": "/etc/conf",
        "kind": "bind",
        "name": null,
        "read_write": false,
        "source": "/srv/conf"
      }
    ],
    "names": [
      "web"
    ],
    "networks": [
      "shop_default"
    ],
    "ports": [
      {
        "ip": "0.0.0.0",
        "private_port": 80,
        "protocol": "tcp",
        "public_port": 8080
      },
      {
        "ip": null,
        "private_port": 443,
        "protocol": "tcp",
        "public_port": null
      }
    ],
    "state": "running",
    "status": "Up 3 hours"
  },
  "tty": false
}
export const result_list_containers: Container[] = [
  {
    "compose_project": "shop",
    "compose_service": "web",
    "created": 1727300000,
    "endpoints": [
      {
        "aliases": [
          "web"
        ],
        "gateway": "172.18.0.1",
        "ip_address": "172.18.0.2",
        "ipv6_address": null,
        "mac_address": "02:42:ac:12:00:02",
        "name": "shop_default"
      }
    ],
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "image": "nginx:1.27",
    "image_id": "sha256:aa11",
    "mounts": [
      {
        "destination": "/data",
        "kind": "volume",
        "name": "data",
        "read_write": true,
        "source": "/var/lib/docker/volumes/data/_data"
      },
      {
        "destination": "/etc/conf",
        "kind": "bind",
        "name": null,
        "read_write": false,
        "source": "/srv/conf"
      }
    ],
    "names": [
      "web"
    ],
    "networks": [
      "shop_default"
    ],
    "ports": [
      {
        "ip": "0.0.0.0",
        "private_port": 80,
        "protocol": "tcp",
        "public_port": 8080
      },
      {
        "ip": null,
        "private_port": 443,
        "protocol": "tcp",
        "public_port": null
      }
    ],
    "state": "running",
    "status": "Up 3 hours"
  },
  {
    "compose_project": null,
    "compose_service": null,
    "created": 0,
    "endpoints": [],
    "id": "b2",
    "image": "alpine",
    "image_id": "sha256:bb22",
    "mounts": [],
    "names": [
      "job"
    ],
    "networks": [],
    "ports": [],
    "state": "exited",
    "status": "Exited (1) 2 minutes ago"
  }
]
export const result_list_images: Image[] = [
  {
    "containers": 1,
    "created": 1727300000,
    "dangling": false,
    "id": "sha256:aa11",
    "reference": "nginx:1.27",
    "repository": "nginx",
    "size_bytes": 190000000,
    "tag": "1.27"
  },
  {
    "containers": 0,
    "created": 0,
    "dangling": true,
    "id": "sha256:bb22",
    "reference": "<none>:<none>",
    "repository": "<none>",
    "size_bytes": 5000,
    "tag": "<none>"
  }
]
export const result_list_networks: Network[] = [
  {
    "compose_project": "shop",
    "connected": [
      "web"
    ],
    "driver": "bridge",
    "id": "n1",
    "internal": false,
    "name": "shop_default",
    "scope": "local",
    "subnets": [
      "172.18.0.0/16"
    ],
    "system": false
  }
]
export const result_list_stacks: StackSummary[] = [
  {
    "config_files": [
      "compose.yaml"
    ],
    "containers": 2,
    "editable": true,
    "name": "shop",
    "origin": "managed",
    "path": "/home/u/.local/share/dockinng/stacks/shop",
    "running": 1,
    "services": [
      {
        "image": "nginx:1.27",
        "name": "web",
        "replicas": "1/1",
        "running": 1,
        "state": "running",
        "total": 1
      }
    ],
    "status": "partial",
    "working_dir": null
  }
]
export const result_list_volumes: Volume[] = [
  {
    "anonymous": false,
    "compose_project": "shop",
    "created_at": "2025-01-02T03:04:05Z",
    "driver": "local",
    "labels": {
      "com.docker.compose.project": "shop"
    },
    "mountpoint": "/var/lib/docker/volumes/data/_data",
    "name": "data",
    "size_bytes": 4096,
    "used_by": [
      "web"
    ]
  }
]
export const result_notify_user: null = null
export const result_open_port_in_browser: null = null
export const result_plan_action: ActionPlan = {
  "affected": [
    {
      "detail": "imagen nginx",
      "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
      "kind": "container",
      "name": "web",
      "size_bytes": 2048,
      "state": "running"
    },
    {
      "detail": null,
      "id": "data",
      "kind": "volume",
      "name": "data",
      "size_bytes": null,
      "state": null
    }
  ],
  "decision": {
    "expected": "ELIMINAR",
    "type": "confirm_typed"
  },
  "expires_in_secs": 60,
  "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
  "total_size_bytes": 2048,
  "warnings": [
    {
      "count": 1,
      "type": "running_force"
    },
    {
      "items": [
        "data"
      ],
      "type": "volumes_kept"
    }
  ]
}
export const result_plan_create_container: CreatePlan = {
  "decision": {
    "type": "confirm"
  },
  "expires_in_secs": 120,
  "field_errors": [
    {
      "field": "name",
      "message": "ya existe"
    }
  ],
  "normalized": {
    "command": null,
    "env": [
      {
        "key": "MODE",
        "value": "prod"
      }
    ],
    "image": "nginx:1.27",
    "labels": {
      "team": "a"
    },
    "name": "web",
    "network": null,
    "ports": [
      {
        "container_port": 80,
        "host_ip": "127.0.0.1",
        "host_port": 8080,
        "protocol": "tcp"
      }
    ],
    "restart": "unless-stopped",
    "restart_max_retries": null,
    "volumes": [
      {
        "read_only": false,
        "source": "data",
        "target": "/data"
      }
    ]
  },
  "ok": false,
  "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
  "warnings": [
    {
      "type": "docker_socket"
    },
    {
      "by": "x",
      "port": 8080,
      "type": "port_in_use"
    }
  ]
}
export const result_podman_detect: PodmanCandidate[] = [
  {
    "path": "/run/user/1000/podman/podman.sock",
    "rootless": true,
    "source": "xdg"
  }
]
export const result_prefs_get: unknown | null = {
  "ms": 5000
}
export const result_prefs_set: null = null
export const result_quit_app: null = null
export const result_reconnect: ConnectionStatus = {
  "cause": "socket_missing",
  "endpoint": "unix:///var/run/docker.sock",
  "message": "no existe el socket",
  "state": "failed",
  "steps": [
    {
      "detail": "ausente",
      "id": "socket",
      "status": "fail"
    },
    {
      "detail": "",
      "id": "permissions",
      "status": "skipped"
    }
  ]
}
export const result_registry_delete: null = null
export const result_registry_list: RegistrySummary[] = [
  {
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
    "server": "ghcr.io",
    "username": "ana"
  }
]
export const result_registry_save: RegistrySummary = {
  "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
  "server": "ghcr.io",
  "username": "ana"
}
export const result_registry_test: null = null
export const result_reset_subscriptions: null = null
export const result_restart_container: null = null
export const result_run_stack_op: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_stack_create: StackSummary = {
  "config_files": [
    "compose.yaml"
  ],
  "containers": 2,
  "editable": true,
  "name": "shop",
  "origin": "managed",
  "path": "/home/u/.local/share/dockinng/stacks/shop",
  "running": 1,
  "services": [
    {
      "image": "nginx:1.27",
      "name": "web",
      "replicas": "1/1",
      "running": 1,
      "state": "running",
      "total": 1
    }
  ],
  "status": "partial",
  "working_dir": null
}
export const result_stack_link: StackSummary = {
  "config_files": [
    "compose.yaml"
  ],
  "containers": 2,
  "editable": true,
  "name": "shop",
  "origin": "managed",
  "path": "/home/u/.local/share/dockinng/stacks/shop",
  "running": 1,
  "services": [
    {
      "image": "nginx:1.27",
      "name": "web",
      "replicas": "1/1",
      "running": 1,
      "state": "running",
      "total": 1
    }
  ],
  "status": "partial",
  "working_dir": null
}
export const result_stack_read: StackFiles = {
  "config_files": [
    "/x/compose.yaml"
  ],
  "editable": true,
  "env": "A=1\n",
  "env_path": "/x/.env",
  "name": "shop",
  "origin": "managed",
  "path": "/x/compose.yaml",
  "revision": "sha256:cc33",
  "yaml": "services: {}\n"
}
export const result_stack_save: StackFiles = {
  "config_files": [
    "/x/compose.yaml"
  ],
  "editable": true,
  "env": "A=1\n",
  "env_path": "/x/.env",
  "name": "shop",
  "origin": "managed",
  "path": "/x/compose.yaml",
  "revision": "sha256:cc33",
  "yaml": "services: {}\n"
}
export const result_stack_unlink: null = null
export const result_stack_validate: StackValidation = {
  "issues": [
    {
      "column": 4,
      "kind": "syntax",
      "line": 2,
      "message": "sangría"
    }
  ],
  "ok": false,
  "risks": [
    {
      "type": "privileged"
    },
    {
      "path": "/etc",
      "type": "sensitive_bind"
    }
  ],
  "services": [
    "web"
  ]
}
export const result_start_container: null = null
export const result_stop_container: null = null
export const result_subscribe_app_events: null = null
export const result_subscribe_build: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_subscribe_engine_events: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_subscribe_exec: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_subscribe_logs: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_subscribe_pull: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_subscribe_stats: string = "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
export const result_system_usage: SystemUsage = {
  "container_disk": [
    {
      "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
      "size_rw_bytes": 2048
    }
  ],
  "disk": {
    "build_cache": {
      "reclaimable_bytes": 0,
      "total_bytes": 0
    },
    "containers": {
      "reclaimable_bytes": null,
      "total_bytes": null
    },
    "images": {
      "reclaimable_bytes": 500,
      "total_bytes": 1000
    },
    "volumes": {
      "reclaimable_bytes": 0,
      "total_bytes": 10
    }
  },
  "disk_known": true,
  "host": {
    "cpu_count": 8,
    "mem_total_bytes": 17179869184
  }
}
export const result_tray_status: TrayStatus = {
  "available": false,
  "error": "falta libayatana-appindicator"
}
export const result_unsubscribe: null = null
export const result_window_close: null = null
export const result_window_minimize: null = null
export const result_window_set_decorations: null = null
export const result_window_start_drag: null = null
export const result_window_start_resize: null = null
export const result_window_toggle_maximize: null = null

/** Argumentos EXACTOS que la webview manda a `invoke` (camelCase). `{ "$channel": Feed }` = argumento Channel (`onEvent`). */
export const COMMANDS = {
  build_plan: { args: {
    "spec": {
      "build_args": [
        [
          "VERSION",
          "1"
        ]
      ],
      "context_dir": "/home/u/app",
      "dockerfile": "Dockerfile",
      "no_cache": false,
      "pull": true,
      "tag": "app:dev",
      "target": null
    }
  }, resultType: "BuildPlan", result: result_build_plan },
  busy_summary: { args: {}, resultType: "BusySummary", result: result_busy_summary },
  cancel_action: { args: {
    "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d"
  }, resultType: "void", result: result_cancel_action },
  cancel_stack_op: { args: {
    "subscriptionId": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
  }, resultType: "void", result: result_cancel_stack_op },
  cleanup_report: { args: {
    "minAgeDays": 7
  }, resultType: "CleanupReport", result: result_cleanup_report },
  compose_info: { args: {
    "recheck": false
  }, resultType: "ComposeInfo", result: result_compose_info },
  connection_delete: { args: {
    "confirmed": true,
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3e"
  }, resultType: "void", result: result_connection_delete },
  connection_list: { args: {}, resultType: "ConnectionProfile[]", result: result_connection_list },
  connection_probe_host_key: { args: {
    "spec": {
      "host": "10.0.0.5",
      "identity": {
        "type": "agent"
      },
      "kind": "ssh",
      "mode": "explicit",
      "name": "srv",
      "port": 22,
      "user": "deploy"
    }
  }, resultType: "HostKeyProbe", result: result_connection_probe_host_key },
  connection_save: { args: {
    "id": null,
    "spec": {
      "host": "10.0.0.5",
      "identity": {
        "type": "agent"
      },
      "kind": "ssh",
      "mode": "explicit",
      "name": "srv",
      "port": 22,
      "user": "deploy"
    }
  }, resultType: "ConnectionProfile", result: result_connection_save },
  connection_select: { args: {
    "id": "local"
  }, resultType: "ConnectionStatus", result: result_connection_select },
  connection_status: { args: {}, resultType: "ConnectionStatus", result: result_connection_status },
  connection_test: { args: {
    "spec": {
      "host": "10.0.0.5",
      "identity": {
        "type": "agent"
      },
      "kind": "ssh",
      "mode": "explicit",
      "name": "srv",
      "port": 22,
      "user": "deploy"
    }
  }, resultType: "ConnTestResult", result: result_connection_test },
  connection_trust_host_key: { args: {
    "fingerprint": "SHA256:abc",
    "spec": {
      "host": "10.0.0.5",
      "identity": {
        "type": "agent"
      },
      "kind": "ssh",
      "mode": "explicit",
      "name": "srv",
      "port": 22,
      "user": "deploy"
    }
  }, resultType: "HostKeyProbe", result: result_connection_trust_host_key },
  container_stats_snapshot: { args: {
    "ids": [
      "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
      "b2"
    ]
  }, resultType: "StatsSnapshotItem[]", result: result_container_stats_snapshot },
  create_container: { args: {
    "spec": {
      "command": null,
      "env": [
        {
          "key": "MODE",
          "value": "prod"
        }
      ],
      "image": "nginx:1.27",
      "labels": {
        "team": "a"
      },
      "name": "web",
      "network": null,
      "ports": [
        {
          "container_port": 80,
          "host_ip": "127.0.0.1",
          "host_port": 8080,
          "protocol": "tcp"
        }
      ],
      "restart": "unless-stopped",
      "restart_max_retries": null,
      "volumes": [
        {
          "read_only": false,
          "source": "data",
          "target": "/data"
        }
      ]
    },
    "start": true,
    "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d"
  }, resultType: "CreateResult", result: result_create_container },
  create_network: { args: {
    "spec": {
      "gateway": null,
      "internal": false,
      "labels": {},
      "name": "lan",
      "subnet": "10.9.0.0/24"
    }
  }, resultType: "Network", result: result_create_network },
  create_volume: { args: {
    "spec": {
      "labels": {
        "a": "b"
      },
      "name": "data"
    }
  }, resultType: "Volume", result: result_create_volume },
  exec_close: { args: {
    "subscriptionId": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
  }, resultType: "void", result: result_exec_close },
  exec_resize: { args: {
    "cols": 100,
    "rows": 30,
    "subscriptionId": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
  }, resultType: "void", result: result_exec_resize },
  exec_write: { args: {
    "data": "bHMK",
    "subscriptionId": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
  }, resultType: "void", result: result_exec_write },
  execute_action: { args: {
    "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
    "typed": "ELIMINAR"
  }, resultType: "ActionOutcome", result: result_execute_action },
  gpu_status: { args: {}, resultType: "GpuInfo[]", result: result_gpu_status },
  groups_import_legacy: { args: {
    "payload": {
      "assign": {
        "local\u0000web": "g1"
      },
      "groups": [
        {
          "hue": 210,
          "id": "g1",
          "name": "Web"
        }
      ],
      "stackHue": {
        "shop": 120
      },
      "v": 1
    }
  }, resultType: "LegacyImportReport", result: result_groups_import_legacy },
  groups_load: { args: {}, resultType: "GroupsSnapshot", result: result_groups_load },
  groups_mutate: { args: {
    "op": {
      "hue": 210,
      "name": "Web",
      "type": "create_group"
    }
  }, resultType: "GroupsSnapshot", result: result_groups_mutate },
  inspect_container: { args: {
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30"
  }, resultType: "ContainerDetail", result: result_inspect_container },
  list_containers: { args: {
    "all": true
  }, resultType: "Container[]", result: result_list_containers },
  list_images: { args: {}, resultType: "Image[]", result: result_list_images },
  list_networks: { args: {}, resultType: "Network[]", result: result_list_networks },
  list_stacks: { args: {}, resultType: "StackSummary[]", result: result_list_stacks },
  list_volumes: { args: {}, resultType: "Volume[]", result: result_list_volumes },
  notify_user: { args: {
    "body": "app:dev",
    "kind": "op_done",
    "title": "Build listo"
  }, resultType: "void", result: result_notify_user },
  open_port_in_browser: { args: {
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "port": 8080,
    "scheme": "http"
  }, resultType: "void", result: result_open_port_in_browser },
  plan_action: { args: {
    "request": {
      "ids": [
        "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30"
      ],
      "type": "remove_containers"
    }
  }, resultType: "ActionPlan", result: result_plan_action },
  plan_create_container: { args: {
    "spec": {
      "command": null,
      "env": [
        {
          "key": "MODE",
          "value": "prod"
        }
      ],
      "image": "nginx:1.27",
      "labels": {
        "team": "a"
      },
      "name": "web",
      "network": null,
      "ports": [
        {
          "container_port": 80,
          "host_ip": "127.0.0.1",
          "host_port": 8080,
          "protocol": "tcp"
        }
      ],
      "restart": "unless-stopped",
      "restart_max_retries": null,
      "volumes": [
        {
          "read_only": false,
          "source": "data",
          "target": "/data"
        }
      ]
    }
  }, resultType: "CreatePlan", result: result_plan_create_container },
  podman_detect: { args: {}, resultType: "PodmanCandidate[]", result: result_podman_detect },
  prefs_get: { args: {
    "key": "polling"
  }, resultType: "json | null", result: result_prefs_get },
  prefs_set: { args: {
    "key": "notify_events",
    "value": {
      "die": true,
      "oom": false
    }
  }, resultType: "void", result: result_prefs_set },
  quit_app: { args: {
    "confirmed": false
  }, resultType: "void", result: result_quit_app },
  reconnect: { args: {}, resultType: "ConnectionStatus", result: result_reconnect },
  registry_delete: { args: {
    "confirmed": true,
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d"
  }, resultType: "void", result: result_registry_delete },
  registry_list: { args: {}, resultType: "RegistrySummary[]", result: result_registry_list },
  registry_save: { args: {
    "secret": "token-de-prueba",
    "server": "ghcr.io",
    "username": "ana"
  }, resultType: "RegistrySummary", result: result_registry_save },
  registry_test: { args: {
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d"
  }, resultType: "void", result: result_registry_test },
  reset_subscriptions: { args: {}, resultType: "void", result: result_reset_subscriptions },
  restart_container: { args: {
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30"
  }, resultType: "void", result: result_restart_container },
  run_stack_op: { args: {
    "name": "shop",
    "onEvent": {
      "$channel": "StackOpFeed"
    },
    "op": {
      "services": null,
      "type": "up"
    }
  }, resultType: "string", result: result_run_stack_op },
  stack_create: { args: {
    "env": "",
    "name": "shop",
    "yaml": "services: {}\n"
  }, resultType: "StackSummary", result: result_stack_create },
  stack_link: { args: {
    "path": "/home/u/shop/compose.yaml"
  }, resultType: "StackSummary", result: result_stack_link },
  stack_read: { args: {
    "name": "shop"
  }, resultType: "StackFiles", result: result_stack_read },
  stack_save: { args: {
    "env": "A=1\n",
    "expectedRevision": "sha256:cc33",
    "name": "shop",
    "yaml": "services: {}\n"
  }, resultType: "StackFiles", result: result_stack_save },
  stack_unlink: { args: {
    "name": "shop"
  }, resultType: "void", result: result_stack_unlink },
  stack_validate: { args: {
    "env": "",
    "name": "shop",
    "yaml": "services: {}\n"
  }, resultType: "StackValidation", result: result_stack_validate },
  start_container: { args: {
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30"
  }, resultType: "void", result: result_start_container },
  stop_container: { args: {
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30"
  }, resultType: "void", result: result_stop_container },
  subscribe_app_events: { args: {
    "onEvent": {
      "$channel": "AppFeed"
    }
  }, resultType: "void", result: result_subscribe_app_events },
  subscribe_build: { args: {
    "onEvent": {
      "$channel": "BuildFeed"
    },
    "spec": {
      "build_args": [
        [
          "VERSION",
          "1"
        ]
      ],
      "context_dir": "/home/u/app",
      "dockerfile": "Dockerfile",
      "no_cache": false,
      "pull": true,
      "tag": "app:dev",
      "target": null
    },
    "ticket": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d"
  }, resultType: "string", result: result_subscribe_build },
  subscribe_engine_events: { args: {
    "onEvent": {
      "$channel": "EngineFeed"
    }
  }, resultType: "string", result: result_subscribe_engine_events },
  subscribe_exec: { args: {
    "cols": 80,
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "onEvent": {
      "$channel": "ExecFeed"
    },
    "rows": 24
  }, resultType: "string", result: result_subscribe_exec },
  subscribe_logs: { args: {
    "follow": true,
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "onEvent": {
      "$channel": "LogFeed"
    },
    "tail": 200
  }, resultType: "string", result: result_subscribe_logs },
  subscribe_pull: { args: {
    "onEvent": {
      "$channel": "PullFeed"
    },
    "reference": "nginx:latest"
  }, resultType: "string", result: result_subscribe_pull },
  subscribe_stats: { args: {
    "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    "onEvent": {
      "$channel": "StatsFeed"
    }
  }, resultType: "string", result: result_subscribe_stats },
  system_usage: { args: {}, resultType: "SystemUsage", result: result_system_usage },
  tray_status: { args: {}, resultType: "TrayStatus", result: result_tray_status },
  unsubscribe: { args: {
    "subscriptionId": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3c"
  }, resultType: "void", result: result_unsubscribe },
  window_close: { args: {}, resultType: "void", result: result_window_close },
  window_minimize: { args: {}, resultType: "void", result: result_window_minimize },
  window_set_decorations: { args: {
    "enabled": false
  }, resultType: "void", result: result_window_set_decorations },
  window_start_drag: { args: {}, resultType: "void", result: result_window_start_drag },
  window_start_resize: { args: {
    "direction": "south_east"
  }, resultType: "void", result: result_window_start_resize },
  window_toggle_maximize: { args: {}, resultType: "void", result: result_window_toggle_maximize },
} as const

/** Un ApiError por código y por causa (`Record<…>`: una variante nueva o retirada en Rust o en TS rompe `tsc -b`). */
export const API_ERRORS_BY_CODE: Record<ApiErrorCode, ApiError> = {
  "auth_required": {
    "cause": null,
    "code": "auth_required",
    "message": "mensaje de AuthRequired"
  },
  "compose_failed": {
    "cause": null,
    "code": "compose_failed",
    "message": "mensaje de ComposeFailed"
  },
  "compose_missing": {
    "cause": null,
    "code": "compose_missing",
    "message": "mensaje de ComposeMissing"
  },
  "conflict": {
    "cause": null,
    "code": "conflict",
    "message": "mensaje de Conflict"
  },
  "connection": {
    "cause": null,
    "code": "connection",
    "message": "mensaje de Connection"
  },
  "engine": {
    "cause": null,
    "code": "engine",
    "message": "mensaje de Engine"
  },
  "image_missing": {
    "cause": null,
    "code": "image_missing",
    "message": "mensaje de ImageMissing"
  },
  "internal": {
    "cause": null,
    "code": "internal",
    "message": "mensaje de Internal"
  },
  "invalid_compose": {
    "cause": null,
    "code": "invalid_compose",
    "message": "mensaje de InvalidCompose"
  },
  "invalid_input": {
    "cause": null,
    "code": "invalid_input",
    "message": "mensaje de InvalidInput"
  },
  "no_shell": {
    "cause": null,
    "code": "no_shell",
    "message": "mensaje de NoShell"
  },
  "not_found": {
    "cause": null,
    "code": "not_found",
    "message": "mensaje de NotFound"
  },
  "not_implemented": {
    "cause": null,
    "code": "not_implemented",
    "message": "mensaje de NotImplemented"
  },
  "policy_denied": {
    "cause": null,
    "code": "policy_denied",
    "message": "mensaje de PolicyDenied"
  },
  "registry_unreachable": {
    "cause": null,
    "code": "registry_unreachable",
    "message": "mensaje de RegistryUnreachable"
  },
  "state_changed": {
    "cause": null,
    "code": "state_changed",
    "message": "mensaje de StateChanged"
  },
  "ticket_expired": {
    "cause": null,
    "code": "ticket_expired",
    "message": "mensaje de TicketExpired"
  },
  "ticket_invalid": {
    "cause": null,
    "code": "ticket_invalid",
    "message": "mensaje de TicketInvalid"
  },
  "timeout": {
    "cause": null,
    "code": "timeout",
    "message": "mensaje de Timeout"
  },
  "typed_mismatch": {
    "cause": null,
    "code": "typed_mismatch",
    "message": "mensaje de TypedMismatch"
  }
}
export const API_ERRORS_BY_CAUSE: Record<ConnectionCause, ApiError> = {
  "auth_failed": {
    "cause": "auth_failed",
    "code": "connection",
    "message": "sin conexión"
  },
  "daemon_down": {
    "cause": "daemon_down",
    "code": "connection",
    "message": "sin conexión"
  },
  "host_key_changed": {
    "cause": "host_key_changed",
    "code": "connection",
    "message": "sin conexión"
  },
  "host_key_unknown": {
    "cause": "host_key_unknown",
    "code": "connection",
    "message": "sin conexión"
  },
  "other": {
    "cause": "other",
    "code": "connection",
    "message": "sin conexión"
  },
  "permission_denied": {
    "cause": "permission_denied",
    "code": "connection",
    "message": "sin conexión"
  },
  "remote_docker_missing": {
    "cause": "remote_docker_missing",
    "code": "connection",
    "message": "sin conexión"
  },
  "socket_missing": {
    "cause": "socket_missing",
    "code": "connection",
    "message": "sin conexión"
  },
  "tls_invalid": {
    "cause": "tls_invalid",
    "code": "connection",
    "message": "sin conexión"
  },
  "unreachable": {
    "cause": "unreachable",
    "code": "connection",
    "message": "sin conexión"
  }
}
export const API_ERROR_QUIESCED: ApiError = {
  "cause": null,
  "code": "conflict",
  "message": "cambio de conexión en curso",
  "quiesced": true
}

/** Una instancia por variante de AppFeed. */
export const FEED_AppFeed: AppFeed[] = [
  {
    "summary": {
      "builds": 1,
      "pulls": 0,
      "stacks": 1,
      "terminals": 2
    },
    "type": "quit_requested"
  },
  {
    "type": "window_visibility",
    "visible": false
  },
  {
    "type": "window_visibility",
    "visible": true
  }
]

/** Una instancia por variante de BuildFeed. */
export const FEED_BuildFeed: BuildFeed[] = [
  {
    "stream": "stdout",
    "text": "Step 1/3",
    "type": "line"
  },
  {
    "lines": [
      {
        "stream": "stdout",
        "text": "a"
      },
      {
        "stream": "stderr",
        "text": "b"
      }
    ],
    "type": "lines"
  },
  {
    "n": 1,
    "total": 3,
    "type": "step"
  },
  {
    "error": null,
    "image_id": "sha256:ee55",
    "outcome": "ok",
    "type": "ended"
  },
  {
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "image_id": null,
    "outcome": "failed",
    "type": "ended"
  },
  {
    "error": null,
    "image_id": null,
    "outcome": "canceled",
    "type": "ended"
  }
]

/** Una instancia por variante de EngineFeed. */
export const FEED_EngineFeed: EngineFeed[] = [
  {
    "items": [
      {
        "action": "die",
        "attributes": {
          "exitCode": "1"
        },
        "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
        "kind": "container",
        "name": "web",
        "time_nano": 1727300000000000000
      },
      {
        "action": "pull",
        "attributes": {
          "exitCode": "1"
        },
        "id": "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
        "kind": "image",
        "name": "web",
        "time_nano": 1727300000000000000
      }
    ],
    "resync": false,
    "type": "events"
  },
  {
    "items": [],
    "resync": true,
    "type": "events"
  },
  {
    "status": {
      "endpoint": "unix:///var/run/docker.sock",
      "server": {
        "api_version": "1.47",
        "arch": "amd64",
        "os": "linux",
        "version": "27.3.1"
      },
      "state": "connected"
    },
    "type": "connection"
  },
  {
    "status": {
      "cause": "socket_missing",
      "endpoint": "unix:///var/run/docker.sock",
      "message": "no existe el socket",
      "state": "failed",
      "steps": [
        {
          "detail": "ausente",
          "id": "socket",
          "status": "fail"
        },
        {
          "detail": "",
          "id": "permissions",
          "status": "skipped"
        }
      ]
    },
    "type": "connection"
  },
  {
    "reason": "eof",
    "type": "ended"
  },
  {
    "reason": "container_stopped",
    "type": "ended"
  },
  {
    "reason": "error",
    "type": "ended"
  },
  {
    "reason": "internal",
    "type": "ended"
  }
]

/** Una instancia por variante de ExecFeed. */
export const FEED_ExecFeed: ExecFeed[] = [
  {
    "risk": {
      "docker_socket": false,
      "host_network": true,
      "host_pid": false,
      "privileged": true
    },
    "shell": "/bin/sh",
    "type": "opened"
  },
  {
    "data": "aG9sYQ==",
    "type": "output"
  },
  {
    "error": null,
    "exit_code": 0,
    "reason": "process_exited",
    "type": "ended"
  },
  {
    "error": null,
    "exit_code": null,
    "reason": "container_stopped",
    "type": "ended"
  },
  {
    "error": null,
    "exit_code": null,
    "reason": "closed",
    "type": "ended"
  },
  {
    "error": null,
    "exit_code": null,
    "reason": "no_shell",
    "type": "ended"
  },
  {
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "exit_code": null,
    "reason": "error",
    "type": "ended"
  },
  {
    "error": null,
    "exit_code": null,
    "reason": "internal",
    "type": "ended"
  }
]

/** Una instancia por variante de LogFeed. */
export const FEED_LogFeed: LogFeed[] = [
  {
    "dropped": 3,
    "lines": [
      {
        "message": "listo",
        "stream": "stdout",
        "timestamp": "2025-01-02T03:04:05Z",
        "truncated": false
      },
      {
        "message": "aviso",
        "stream": "stderr",
        "timestamp": null,
        "truncated": false
      },
      {
        "message": "tty",
        "stream": "console",
        "timestamp": null,
        "truncated": false
      }
    ],
    "type": "lines"
  },
  {
    "error": null,
    "reason": "eof",
    "type": "ended"
  },
  {
    "error": null,
    "reason": "container_stopped",
    "type": "ended"
  },
  {
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "reason": "error",
    "type": "ended"
  },
  {
    "error": null,
    "reason": "internal",
    "type": "ended"
  }
]

/** Una instancia por variante de PullFeed. */
export const FEED_PullFeed: PullFeed[] = [
  {
    "reference": "nginx:latest",
    "type": "started"
  },
  {
    "done_bytes": 100,
    "layers": [
      {
        "done": 50,
        "id": "l1",
        "phase": "downloading",
        "total": 100
      },
      {
        "done": 50,
        "id": "l1",
        "phase": "complete",
        "total": 100
      }
    ],
    "total_bytes": 200,
    "type": "progress"
  },
  {
    "digest": "sha256:dd44",
    "error": null,
    "outcome": "done",
    "type": "ended",
    "up_to_date": true
  },
  {
    "digest": null,
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "outcome": "error",
    "type": "ended",
    "up_to_date": false
  }
]

/** Una instancia por variante de StackOpFeed. */
export const FEED_StackOpFeed: StackOpFeed[] = [
  {
    "compose_version": "2.29.7",
    "op": "up",
    "stack": "shop",
    "type": "started"
  },
  {
    "items": [
      {
        "current": null,
        "details": null,
        "id": "Container shop-web-1",
        "kind": "container",
        "name": "shop-web-1",
        "parent_id": null,
        "percent": null,
        "status": "working",
        "text": "Starting",
        "total": null
      },
      {
        "current": 5,
        "details": "ok",
        "id": "layer1",
        "kind": "image",
        "name": "nginx",
        "parent_id": "Image nginx",
        "percent": 50,
        "status": "done",
        "text": "Pulled",
        "total": 10
      }
    ],
    "services": [
      {
        "name": "web",
        "percent": 80,
        "phase": "pulling"
      }
    ],
    "type": "progress"
  },
  {
    "text": "Container shop-web-1 Started",
    "type": "log"
  },
  {
    "error": null,
    "exit_code": 0,
    "issues": [],
    "outcome": "success",
    "type": "ended"
  },
  {
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "exit_code": 1,
    "issues": [
      {
        "column": null,
        "kind": "schema",
        "line": 3,
        "message": "campo desconocido"
      }
    ],
    "outcome": "failed",
    "type": "ended"
  },
  {
    "error": null,
    "exit_code": 0,
    "issues": [],
    "outcome": "canceled",
    "type": "ended"
  },
  {
    "error": null,
    "exit_code": 0,
    "issues": [],
    "outcome": "timeout",
    "type": "ended"
  }
]

/** Una instancia por variante de StatsFeed. */
export const FEED_StatsFeed: StatsFeed[] = [
  {
    "stats": {
      "block_read_bytes": 3,
      "block_write_bytes": 4,
      "cpu_percent": 12.5,
      "mem_limit_bytes": 2097152,
      "mem_percent": 50,
      "mem_used_bytes": 1048576,
      "net_rx_bytes": 10,
      "net_rx_bytes_per_sec": 1.5,
      "net_tx_bytes": 20,
      "net_tx_bytes_per_sec": 2.5,
      "pids": 7,
      "read_at": "2025-01-02T03:04:05Z"
    },
    "type": "sample"
  },
  {
    "error": null,
    "reason": "eof",
    "type": "ended"
  },
  {
    "error": null,
    "reason": "container_stopped",
    "type": "ended"
  },
  {
    "error": {
      "cause": null,
      "code": "conflict",
      "message": "recurso en uso"
    },
    "reason": "error",
    "type": "ended"
  },
  {
    "error": null,
    "reason": "internal",
    "type": "ended"
  }
]

/** Variantes de ApiErrorCode en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ApiErrorCode: Record<ApiErrorCode, true> = { "connection": true, "not_found": true, "conflict": true, "invalid_input": true, "engine": true, "timeout": true, "policy_denied": true, "ticket_invalid": true, "ticket_expired": true, "typed_mismatch": true, "state_changed": true, "not_implemented": true, "internal": true, "compose_missing": true, "compose_failed": true, "invalid_compose": true, "image_missing": true, "auth_required": true, "registry_unreachable": true, "no_shell": true }

/** Variantes de BuildOutcome en Rust (exhaustivo en ambos sentidos). */
export const ENUM_BuildOutcome: Record<BuildOutcome, true> = { "ok": true, "failed": true, "canceled": true }

/** Variantes de BuildStream en Rust (exhaustivo en ambos sentidos). */
export const ENUM_BuildStream: Record<BuildStream, true> = { "stdout": true, "stderr": true }

/** Variantes de CleanupCategoryId en Rust (exhaustivo en ambos sentidos). */
export const ENUM_CleanupCategoryId: Record<CleanupCategoryId, true> = { "stopped_containers": true, "dangling_images": true, "unused_images": true, "unused_volumes": true, "unused_networks": true, "build_cache": true }

/** Variantes de CleanupRisk en Rust (exhaustivo en ambos sentidos). */
export const ENUM_CleanupRisk: Record<CleanupRisk, true> = { "low": true, "medium": true, "high": true }

/** Variantes de ComposeFlavor en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ComposeFlavor: Record<ComposeFlavor, true> = { "plugin": true, "standalone": true, "missing": true }

/** Variantes de ConnectionCause en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ConnectionCause: Record<ConnectionCause, true> = { "socket_missing": true, "permission_denied": true, "daemon_down": true, "other": true, "host_key_unknown": true, "host_key_changed": true, "auth_failed": true, "unreachable": true, "remote_docker_missing": true, "tls_invalid": true }

/** Variantes de ContainerState en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ContainerState: Record<ContainerState, true> = { "created": true, "running": true, "paused": true, "restarting": true, "removing": true, "stopping": true, "exited": true, "dead": true, "unknown": true }

/** Variantes de DiagStepId en Rust (exhaustivo en ambos sentidos). */
export const ENUM_DiagStepId: Record<DiagStepId, true> = { "socket": true, "permissions": true, "daemon": true }

/** Variantes de EndReason en Rust (exhaustivo en ambos sentidos). */
export const ENUM_EndReason: Record<EndReason, true> = { "eof": true, "container_stopped": true, "error": true, "internal": true }

/** Variantes de EngineEventKind en Rust (exhaustivo en ambos sentidos). */
export const ENUM_EngineEventKind: Record<EngineEventKind, true> = { "container": true, "image": true, "volume": true, "network": true, "daemon": true, "other": true }

/** Variantes de ExecEndReason en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ExecEndReason: Record<ExecEndReason, true> = { "process_exited": true, "container_stopped": true, "closed": true, "no_shell": true, "error": true, "internal": true }

/** Variantes de HostKeyState en Rust (exhaustivo en ambos sentidos). */
export const ENUM_HostKeyState: Record<HostKeyState, true> = { "unknown": true, "trusted": true, "changed": true }

/** Variantes de ValidationKind en Rust (exhaustivo en ambos sentidos). */
export const ENUM_IssueKind: Record<ValidationKind, true> = { "syntax": true, "schema": true, "interpolation": true, "other": true }

/** Variantes de AffectedKind en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ItemKind: Record<AffectedKind, true> = { "container": true, "image": true, "volume": true, "network": true, "stack": true }

/** Variantes de LayerPhase en Rust (exhaustivo en ambos sentidos). */
export const ENUM_LayerPhase: Record<LayerPhase, true> = { "waiting": true, "downloading": true, "downloaded": true, "extracting": true, "complete": true }

/** Variantes de LogStream en Rust (exhaustivo en ambos sentidos). */
export const ENUM_LogStream: Record<LogStream, true> = { "stdout": true, "stderr": true, "console": true }

/** Variantes de MountKind en Rust (exhaustivo en ambos sentidos). */
export const ENUM_MountKind: Record<MountKind, true> = { "volume": true, "bind": true, "tmpfs": true, "other": true }

/** Variantes de DenyReason en Rust (exhaustivo en ambos sentidos). */
export const ENUM_PlanDenyReason: Record<DenyReason, true> = { "forbidden": true, "needs_confirmation_non_interactive": true }

/** Variantes de PortProtocol en Rust (exhaustivo en ambos sentidos). */
export const ENUM_PortProtocol: Record<PortProtocol, true> = { "tcp": true, "udp": true }

/** Variantes de ProgressKind en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ProgressKind: Record<ProgressKind, true> = { "network": true, "container": true, "volume": true, "image": true, "service": true, "other": true }

/** Variantes de ProgressStatus en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ProgressStatus: Record<ProgressStatus, true> = { "working": true, "done": true, "warning": true, "error": true }

/** Variantes de PullOutcome en Rust (exhaustivo en ambos sentidos). */
export const ENUM_PullOutcome: Record<PullOutcome, true> = { "done": true, "error": true }

/** Variantes de Restart en Rust (exhaustivo en ambos sentidos). */
export const ENUM_RestartPolicy: Record<Restart, true> = { "no": true, "always": true, "unless-stopped": true, "on-failure": true }

/** Variantes de ServicePhase en Rust (exhaustivo en ambos sentidos). */
export const ENUM_ServicePhase: Record<ServicePhase, true> = { "waiting": true, "pulling": true, "creating": true, "started": true }

/** Variantes de CleanupEstimate en Rust (exhaustivo en ambos sentidos). */
export const ENUM_SizeEstimate: Record<CleanupEstimate, true> = { "exact": true, "upper_bound": true, "unknown": true }

/** Variantes de SshMode en Rust (exhaustivo en ambos sentidos). */
export const ENUM_SshMode: Record<SshMode, true> = { "explicit": true, "alias": true }

/** Variantes de StackOrigin en Rust (exhaustivo en ambos sentidos). */
export const ENUM_StackOrigin: Record<StackOrigin, true> = { "managed": true, "linked": true, "discovered": true }

/** Variantes de StackOutcome en Rust (exhaustivo en ambos sentidos). */
export const ENUM_StackOutcome: Record<StackOutcome, true> = { "success": true, "failed": true, "canceled": true, "timeout": true }

/** Variantes de StackStatus en Rust (exhaustivo en ambos sentidos). */
export const ENUM_StackStatus: Record<StackStatus, true> = { "running": true, "partial": true, "stopped": true, "declared": true }

/** Variantes de StepStatus en Rust (exhaustivo en ambos sentidos). */
export const ENUM_StepStatus: Record<StepStatus, true> = { "ok": true, "fail": true, "skipped": true }

/** Una instancia por variante de ActionRequest. */
export const TYPE_ActionRequest: ActionRequest[] = [
  {
    "ids": [
      "3f1a9c0e5b7d2a46e8c0f1b3d5a79e2c4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30"
    ],
    "type": "remove_containers"
  },
  {
    "reference": "nginx:1.27",
    "type": "remove_image"
  },
  {
    "type": "prune_images"
  },
  {
    "name": "data",
    "type": "remove_volume"
  },
  {
    "type": "prune_volumes"
  },
  {
    "id": "n1",
    "type": "remove_network"
  },
  {
    "project": "shop",
    "type": "stack_down"
  },
  {
    "name": "shop",
    "type": "stack_delete"
  },
  {
    "selection": {
      "containers": [
        "b2"
      ],
      "images": [],
      "networks": [],
      "volumes": [
        "data"
      ]
    },
    "type": "cleanup"
  },
  {
    "type": "prune_system"
  }
]

/** Una instancia por variante de BuildWarning. */
export const TYPE_BuildWarning: BuildWarning[] = [
  {
    "path": "/home/u",
    "type": "sensitive_context"
  },
  {
    "name": "TOKEN",
    "type": "secret_like_arg"
  }
]

/** Una instancia por variante de ConnectionStatus. */
export const TYPE_ConnectionStatus: ConnectionStatus[] = [
  {
    "endpoint": "unix:///var/run/docker.sock",
    "server": {
      "api_version": "1.47",
      "arch": "amd64",
      "os": "linux",
      "version": "27.3.1"
    },
    "state": "connected"
  },
  {
    "cause": "host_key_changed",
    "endpoint": "ssh://deploy@10.0.0.5",
    "message": "la clave cambió",
    "state": "failed",
    "steps": []
  }
]

/** Una instancia por variante de ConnSpec. */
export const TYPE_ConnSpec: ConnSpec[] = [
  {
    "host": "10.0.0.5",
    "identity": {
      "type": "agent"
    },
    "kind": "ssh",
    "mode": "explicit",
    "name": "srv",
    "port": 22,
    "user": "deploy"
  },
  {
    "ca_path": "/c/ca.pem",
    "cert_path": "/c/cert.pem",
    "host": "docker.lan",
    "key_path": "/c/key.pem",
    "kind": "tls",
    "name": "tls",
    "port": 2376
  }
]

/** Una instancia por variante de CreateWarning. */
export const TYPE_CreateWarning: CreateWarning[] = [
  {
    "reason": "sistema",
    "source": "/etc",
    "type": "sensitive_bind"
  },
  {
    "type": "docker_socket"
  },
  {
    "type": "host_network"
  },
  {
    "by": "otro",
    "port": 8080,
    "type": "port_in_use"
  },
  {
    "port": 80,
    "type": "published_all_interfaces"
  },
  {
    "source": "/srv",
    "type": "remote_bind"
  }
]

/** Una instancia por variante de GroupOp. */
export const TYPE_GroupOp: GroupOp[] = [
  {
    "hue": 210,
    "name": "Web",
    "type": "create_group"
  },
  {
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
    "name": "Web2",
    "type": "rename_group"
  },
  {
    "hue": 30,
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
    "type": "set_group_hue"
  },
  {
    "id": "0190a5b2-7c1e-7a3f-8b2d-4f6e9c1a2b3d",
    "type": "delete_group"
  },
  {
    "connection_id": "local",
    "group_id": null,
    "names": [
      "web"
    ],
    "type": "assign"
  },
  {
    "hue": null,
    "project": "shop",
    "type": "set_stack_hue"
  }
]

/** Una instancia por variante de PlanDecision. */
export const TYPE_PlanDecision: PlanDecision[] = [
  {
    "type": "allow"
  },
  {
    "type": "confirm"
  },
  {
    "expected": "ELIMINAR",
    "type": "confirm_typed"
  },
  {
    "reason": "forbidden",
    "type": "deny"
  }
]

/** Una instancia por variante de PlanWarning. */
export const TYPE_PlanWarning: PlanWarning[] = [
  {
    "count": 2,
    "type": "running_force"
  },
  {
    "items": [
      "data"
    ],
    "type": "volumes_kept"
  },
  {
    "items": [
      "/srv"
    ],
    "type": "bind_mounts_kept"
  },
  {
    "count": 1,
    "type": "in_use"
  },
  {
    "items": [
      "x"
    ],
    "type": "skipped"
  }
]

/** Una instancia por variante de SshIdentity. */
export const TYPE_SshIdentity: SshIdentity[] = [
  {
    "type": "agent"
  },
  {
    "path": "/home/u/.ssh/id",
    "type": "file"
  }
]

/** Una instancia por variante de StackOpKind. */
export const TYPE_StackOp: StackOpKind[] = [
  {
    "services": null,
    "type": "up"
  },
  {
    "services": [
      "web"
    ],
    "type": "restart"
  },
  {
    "services": null,
    "type": "stop"
  },
  {
    "services": null,
    "type": "start"
  },
  {
    "services": [
      "web",
      "db"
    ],
    "type": "pull"
  }
]

/** Una instancia por variante de StackRisk. */
export const TYPE_StackRisk: StackRisk[] = [
  {
    "type": "privileged"
  },
  {
    "type": "host_network"
  },
  {
    "type": "docker_sock"
  },
  {
    "path": "/etc",
    "type": "sensitive_bind"
  },
  {
    "type": "pid_host"
  },
  {
    "type": "cap_add_sys_admin"
  },
  {
    "path": "/srv",
    "type": "remote_bind"
  }
]
