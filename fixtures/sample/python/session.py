from .token_store import TokenStore

class SessionManager:
    def __init__(self, store: TokenStore):
        self.store = store

    def restore(self):
        return self.store.read()

def create_session(store):
    return SessionManager(store)
