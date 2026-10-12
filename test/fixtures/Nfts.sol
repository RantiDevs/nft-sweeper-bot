// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract MiniNFT {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    mapping(uint256 => address) public ownerOf;
    uint256 public totalSupply;

    function supportsInterface(bytes4 id) external pure virtual returns (bool) {
        return id == 0x80ac58cd || id == 0x01ffc9a7;
    }

    function _mint(address to) internal {
        uint256 id = ++totalSupply;
        ownerOf[id] = to;
        emit Transfer(address(0), to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from, "not owner");
        ownerOf[id] = to;
        emit Transfer(from, to, id);
    }
}

/// Free mint, recipient as an argument, max 2 per caller.
contract FreeNFT is MiniNFT {
    mapping(address => uint256) public minted;
    function mint(address to, uint256 qty) external {
        require(minted[msg.sender] + qty <= 2, "max per wallet");
        minted[msg.sender] += qty;
        for (uint256 i; i < qty; i++) _mint(to);
    }
}

/// Free claim with no arguments.
contract ClaimNFT is MiniNFT {
    mapping(address => bool) public claimed;
    function claim() external {
        require(!claimed[msg.sender], "claimed");
        claimed[msg.sender] = true;
        _mint(msg.sender);
    }
}

/// Paid mint.
contract PaidNFT is MiniNFT {
    function mint() external payable {
        require(msg.value == 0.01 ether, "price");
        _mint(msg.sender);
    }
}

/// Looks free, but the token always goes to the deployer.
contract TrapNFT is MiniNFT {
    address immutable sink = msg.sender;
    function mint() external {
        _mint(sink);
    }
}

/// Emits ERC-721-shaped mint logs but is not an NFT (no ERC-165).
contract FakeNFT {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    uint256 n;
    function mint() external {
        emit Transfer(address(0), msg.sender, ++n);
    }
}
