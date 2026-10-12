# WebPink Pip Adapter
#
# Intercepta o ponto mais baixo e universal por onde QUALQUER cliente HTTP em
# Python passa — socket.create_connection — em vez de tentar reimplementar ou
# remendar camadas mais altas (requests/urllib3), que no ambiente Pyodide+Node
# ja provaram nao ser o caminho real usado pelo pip (ele usa sua propria copia
# vendorizada de urllib3, que nunca passa por requests/urllib.request).
#
# Duas variantes, mesma logica de guarda:
#   - enable_lite(allowlist): pro browser (WebPink Lite) - so checa o dominio.
#   - enable_full(allowlist, verbose=True): pro NodeExecution (WebPink
#     completo) - checa o dominio E loga cada decisao.

import socket

_real_create_connection = socket.create_connection


class WebPinkBlocked(Exception):
    """Levantada quando o WebPink recusa uma conexao antes dela sair."""
    def __init__(self, host):
        self.host = host
        super().__init__(f"WebPink bloqueou a conexao para: {host}")


def _make_guarded_create_connection(allowlist, verbose):
    allowed_hosts = set(allowlist)

    def guarded_create_connection(address, *args, **kwargs):
        host = address[0] if isinstance(address, tuple) else str(address)
        permitido = host in allowed_hosts
        if verbose:
            estado = "PERMITIDO" if permitido else "BLOQUEADO"
            print(f"[WebPink] {estado}: conexao para {host}")
        if not permitido:
            raise WebPinkBlocked(host)
        return _real_create_connection(address, *args, **kwargs)

    return guarded_create_connection


def enable_lite(allowlist):
    """Variante WebPink Lite, pro browser: so valida o dominio, sem log verboso."""
    socket.create_connection = _make_guarded_create_connection(allowlist, verbose=False)


def enable_full(allowlist, verbose=True):
    """Variante WebPink completa, pro NodeExecution: valida e loga cada decisao."""
    socket.create_connection = _make_guarded_create_connection(allowlist, verbose=verbose)


def disable():
    """Restaura a conexao original, sem a guarda do WebPink."""
    socket.create_connection = _real_create_connection
