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

/// Free mint with on-chain JSON metadata: Background Gold on every 10th id, Green on every
/// 3rd, Blue otherwise; a Crown hat on every 25th id. Used to test rarity ranking.
contract TraitNFT is MiniNFT {
    function mint(address to, uint256 qty) external {
        for (uint256 i; i < qty; i++) _mint(to);
    }

    /// A simple ETH sale: the buyer takes the token from its current owner and pays them.
    function buy(uint256 id) external payable {
        address seller = ownerOf[id];
        require(seller != address(0) && msg.value > 0, "bad sale");
        ownerOf[id] = msg.sender;
        emit Transfer(seller, msg.sender, id);
        payable(seller).transfer(msg.value);
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        require(ownerOf[id] != address(0), "no token");
        string memory bg = id % 10 == 0 ? "Gold" : (id % 3 == 0 ? "Green" : "Blue");
        string memory hat = id % 25 == 0
            ? '{"trait_type":"Hat","value":"Crown"}'
            : '{"trait_type":"Hat","value":"None"}';
        return string(abi.encodePacked(
            'data:application/json;utf8,{"name":"T #', _str(id),
            '","attributes":[{"trait_type":"Background","value":"', bg, '"},', hat, ']}'
        ));
    }

    function _str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }
}

/// A limited, first-come-first-served drop: mint() reverts until the owner opens it, and
/// only `maxSupply` tokens can ever be minted (later callers revert and just lose gas).
contract GatedNFT is MiniNFT {
    address immutable owner = msg.sender;
    uint256 public immutable maxSupply;
    bool public open;

    constructor(uint256 max) {
        maxSupply = max;
    }

    function setOpen(bool v) external {
        require(msg.sender == owner, "owner only");
        open = v;
    }

    function mint(address to) external {
        require(open, "closed");
        require(totalSupply < maxSupply, "sold out");
        _mint(to);
    }
}

/// Minimal stand-in for OpenSea's SeaDrop: creators announce a drop (PublicDropUpdated), and
/// anyone can mintPublic() once it has started. Same event, getters and mint signature as the real one.
contract MiniSeaDrop {
    struct PublicDrop {
        uint80 mintPrice;
        uint48 startTime;
        uint48 endTime;
        uint16 maxTotalMintableByWallet;
        uint16 feeBps;
        bool restrictFeeRecipients;
    }
    event PublicDropUpdated(address indexed nftContract, PublicDrop publicDrop);

    mapping(address => PublicDrop) public drops;
    mapping(address => mapping(address => uint256)) public mintedBy;
    address public constant FEE = 0x0000a26b00c1F0DF003000390027140000fAa719;

    function announce(address nft, uint80 price, uint48 start, uint48 end, uint16 maxPerWallet) external {
        PublicDrop memory d = PublicDrop(price, start, end, maxPerWallet, 1000, true);
        drops[nft] = d;
        emit PublicDropUpdated(nft, d);
    }

    function getPublicDrop(address nft) external view returns (PublicDrop memory) {
        return drops[nft];
    }

    function getAllowedFeeRecipients(address) external pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = FEE;
    }

    function mintPublic(address nft, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable {
        PublicDrop memory d = drops[nft];
        require(block.timestamp >= d.startTime && block.timestamp < d.endTime, "not active");
        require(feeRecipient == FEE, "fee recipient");
        require(msg.value == uint256(d.mintPrice) * quantity, "price");
        address to = minterIfNotPayer == address(0) ? msg.sender : minterIfNotPayer;
        require(mintedBy[nft][to] + quantity <= d.maxTotalMintableByWallet, "wallet limit");
        mintedBy[nft][to] += quantity;
        DropNFT(nft).mintFromDrop(to, quantity);
    }
}

/// The collection a SeaDrop mints into. Only its drop contract may mint.
contract DropNFT is MiniNFT {
    address public immutable drop;
    constructor(address d) { drop = d; }
    function mintFromDrop(address to, uint256 qty) external {
        require(msg.sender == drop, "drop only");
        for (uint256 i; i < qty; i++) _mint(to);
    }
}
